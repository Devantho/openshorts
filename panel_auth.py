"""Password protection for the whole panel (single-owner self-host).

One password guards everything the backend serves: the API, ``/videos``,
``/thumbnails`` and ``/mcp``. Only ``/health*`` and the login endpoints stay
open.

* **Password**: ``APP_PASSWORD`` from the environment when set (it then
  cannot be changed from the UI). Otherwise a scrypt hash stored in
  ``DATA_DIR/auth.json``; on first start a random password is generated and
  printed once in the server logs, and it can be changed from Settings.
* **Session**: an HMAC-signed token in an HttpOnly, SameSite=Lax cookie, so
  ``<video src>`` and ``<img src>`` are authenticated without putting a token
  in URLs. The signature covers a fingerprint of the password hash, so
  changing the password logs every session out.
* **Agents** (MCP, curl, n8n): ``Authorization: Bearer <APP_API_TOKEN>``
  when that env var is set.

The middleware also strips any ``X-Gemini-Key`` / ``X-ElevenLabs-Key`` /
``X-Fal-Key`` sent by a client and injects the keys stored server-side
(``settings_store``): the server is the only source of truth for keys.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
import time
from typing import Dict, List, Optional, Tuple

import settings_store

COOKIE_NAME = "bs_session"
SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", str(30 * 24 * 3600)))
AUTH_FILE = os.path.join(settings_store.DATA_DIR, "auth.json")
# "auto" = Secure when the request arrived over https (X-Forwarded-Proto aware).
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").strip().lower()

LOGIN_MAX_ATTEMPTS = int(os.environ.get("LOGIN_MAX_ATTEMPTS", "10"))
LOGIN_WINDOW_SECONDS = int(os.environ.get("LOGIN_WINDOW_SECONDS", "900"))

PUBLIC_PATHS = frozenset({
    "/health", "/health/ready",
    "/api/auth/login", "/api/auth/logout", "/api/auth/status",
})

_KEY_HEADERS = frozenset(h.encode() for h in settings_store.HEADER_FOR_FIELD.values()) | {b"x-upload-post-key"}

_lock = threading.Lock()
_attempts: Dict[str, List[float]] = {}


# ---- password + secret storage ------------------------------------------------

def _hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def _verify_hash(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, digest_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(digest_b64)
    except (ValueError, TypeError):
        return False
    got = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2 ** 14, r=8, p=1, dklen=len(expected))
    return hmac.compare_digest(got, expected)


def _read_auth() -> dict:
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"⚠️ Could not read {AUTH_FILE}: {e}")
        return {}


def _write_auth(data: dict) -> None:
    directory = os.path.dirname(os.path.abspath(AUTH_FILE))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".auth-", dir=directory)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, AUTH_FILE)


def env_password_set() -> bool:
    return bool(os.environ.get("APP_PASSWORD", ""))


def ensure_initialised() -> None:
    """Create the signing secret and, without APP_PASSWORD, a first password."""
    with _lock:
        data = _read_auth()
        changed = False
        if not os.environ.get("APP_SECRET") and not data.get("secret"):
            data["secret"] = secrets.token_hex(32)
            changed = True
        if not env_password_set() and not data.get("password_hash"):
            generated = secrets.token_urlsafe(12)
            data["password_hash"] = _hash_password(generated)
            changed = True
            bar = "=" * 64
            print(f"\n{bar}\n🔐 No APP_PASSWORD set. Generated panel password: {generated}\n"
                  f"   Change it in Settings, or set APP_PASSWORD in your .env.\n{bar}\n", flush=True)
        if changed:
            _write_auth(data)


def _secret() -> bytes:
    env = os.environ.get("APP_SECRET", "")
    if env:
        return env.encode()
    secret = _read_auth().get("secret")
    if not secret:
        ensure_initialised()
        secret = _read_auth().get("secret", "")
    return secret.encode()


def _password_fingerprint() -> str:
    """Changes whenever the password does, which voids existing sessions."""
    env = os.environ.get("APP_PASSWORD", "")
    material = ("env:" + env) if env else ("file:" + (_read_auth().get("password_hash") or ""))
    return hashlib.sha256(material.encode()).hexdigest()[:16]


def check_password(password: str) -> bool:
    if not isinstance(password, str) or not password:
        return False
    env = os.environ.get("APP_PASSWORD", "")
    if env:
        return hmac.compare_digest(password.encode("utf-8"), env.encode("utf-8"))
    stored = _read_auth().get("password_hash")
    return bool(stored) and _verify_hash(password, stored)


def change_password(current: str, new: str) -> None:
    if env_password_set():
        raise PermissionError("The password is set by APP_PASSWORD in the server environment.")
    if not check_password(current):
        raise ValueError("Current password is incorrect.")
    if not isinstance(new, str) or len(new) < 8:
        raise ValueError("The new password must be at least 8 characters.")
    with _lock:
        data = _read_auth()
        data["password_hash"] = _hash_password(new)
        _write_auth(data)


# ---- session tokens -----------------------------------------------------------

def _sign(payload: str) -> str:
    mac = hmac.new(_secret(), (payload + "|" + _password_fingerprint()).encode(), hashlib.sha256)
    return base64.urlsafe_b64encode(mac.digest()).decode().rstrip("=")


def issue_token(now: Optional[float] = None) -> str:
    exp = int((now or time.time()) + SESSION_TTL_SECONDS)
    payload = f"v1.{exp}.{secrets.token_hex(8)}"
    return payload + "." + _sign(payload)


def verify_token(token: Optional[str], now: Optional[float] = None) -> bool:
    if not token:
        return False
    api_token = os.environ.get("APP_API_TOKEN", "")
    if api_token and hmac.compare_digest(token.encode(), api_token.encode()):
        return True
    parts = token.split(".")
    if len(parts) != 4 or parts[0] != "v1":
        return False
    payload = ".".join(parts[:3])
    if not hmac.compare_digest(_sign(payload), parts[3]):
        return False
    try:
        return int(parts[1]) > (now or time.time())
    except ValueError:
        return False


# ---- login rate limit ---------------------------------------------------------

def login_allowed(ip: str) -> bool:
    now = time.monotonic()
    with _lock:
        recent = [t for t in _attempts.get(ip, []) if now - t < LOGIN_WINDOW_SECONDS]
        _attempts[ip] = recent
        return len(recent) < LOGIN_MAX_ATTEMPTS


def record_failure(ip: str) -> None:
    with _lock:
        _attempts.setdefault(ip, []).append(time.monotonic())


def clear_failures(ip: str) -> None:
    with _lock:
        _attempts.pop(ip, None)


# ---- request helpers ----------------------------------------------------------

def _cookie_value(cookie_header: str, name: str) -> Optional[str]:
    for part in cookie_header.split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return v
    return None


def token_from_headers(headers: Dict[str, str]) -> Optional[str]:
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return _cookie_value(headers.get("cookie", ""), COOKIE_NAME)


def cookie_secure(headers: Dict[str, str], scheme: str) -> bool:
    if COOKIE_SECURE in ("1", "true", "yes"):
        return True
    if COOKIE_SECURE in ("0", "false", "no"):
        return False
    proto = headers.get("x-forwarded-proto", "").split(",")[0].strip()
    return (proto or scheme) == "https"


# ---- ASGI middleware ----------------------------------------------------------

class AuthMiddleware:
    """Refuse unauthenticated HTTP requests; inject server-side API keys."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if scope.get("method") == "OPTIONS" or path in PUBLIC_PATHS:
            return await self.app(scope, receive, send)

        raw_headers: List[Tuple[bytes, bytes]] = list(scope.get("headers") or [])
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in raw_headers}
        if not verify_token(token_from_headers(headers)):
            body = b'{"detail":"Authentication required"}'
            await send({"type": "http.response.start", "status": 401, "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"cache-control", b"no-store"),
            ]})
            await send({"type": "http.response.body", "body": body})
            return

        # Server-side keys only: drop whatever the client sent, add ours.
        cleaned = [(k, v) for k, v in raw_headers if k.lower() not in _KEY_HEADERS]
        for name, value in settings_store.injected_headers().items():
            cleaned.append((name.encode("latin-1"), value.encode("latin-1")))
        scope = dict(scope)
        scope["headers"] = cleaned
        return await self.app(scope, receive, send)
