"""Server-side storage for the panel's API keys and publishing settings.

The upstream self-host dashboard kept every key in the browser's localStorage
and sent it on each request as an ``X-*-Key`` header. Here the server is the
only place keys live: the dashboard writes them once through ``PUT
/api/settings`` and never reads them back (``public_view`` only says whether a
key is set and shows its last four characters). ``panel_auth.AuthMiddleware``
then injects the stored keys into each authenticated request, so the
endpoints that read those headers keep working unchanged.

Storage is one JSON file under ``DATA_DIR`` (default ``data/``, deliberately
not under ``output/``, which is served at ``/videos``), written atomically
with mode 0600. Environment variables remain a fallback for every key, so an
install configured through ``.env`` works without touching the UI.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from typing import Any, Dict, Optional

DATA_DIR = os.environ.get("DATA_DIR", "data")
SETTINGS_FILE = os.environ.get("SETTINGS_FILE", os.path.join(DATA_DIR, "settings.json"))

# name -> environment fallback
SECRET_FIELDS: Dict[str, str] = {
    "gemini_api_key": "GEMINI_API_KEY",
    "elevenlabs_api_key": "ELEVENLABS_API_KEY",
    "fal_api_key": "FAL_KEY",
    "postiz_api_key": "POSTIZ_API_KEY",
}

# Non-secret settings, returned as-is by public_view.
PLAIN_FIELDS: Dict[str, str] = {
    "postiz_url": "POSTIZ_URL",
}

# Request header each stored key is injected as (see panel_auth).
HEADER_FOR_FIELD: Dict[str, str] = {
    "gemini_api_key": "x-gemini-key",
    "elevenlabs_api_key": "x-elevenlabs-key",
    "fal_api_key": "x-fal-key",
}

DEFAULT_PUBLISH: Dict[str, Any] = {
    # Defaults applied to every Postiz post (manual and automatic).
    "youtube_privacy": "public",            # public | unlisted | private
    "tiktok_privacy": "PUBLIC_TO_EVERYONE",  # PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY
    "tiktok_method": "DIRECT_POST",          # DIRECT_POST | UPLOAD (TikTok inbox)
    "instagram_post_type": "post",          # post (reel) | story
    "hashtags": "",                          # appended to every description
}

DEFAULT_AUTOPOST: Dict[str, Any] = {
    "enabled": False,
    "integration_ids": [],   # Postiz channel ids to publish on
    "clips_per_job": 3,      # best N clips by predicted score
    "mode": "schedule",      # schedule | draft
    "first_delay_minutes": 15,
    "spacing_hours": 24,     # gap between two clips of the same job
}

_lock = threading.Lock()


def _read() -> Dict[str, Any]:
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"⚠️ Could not read {SETTINGS_FILE}: {e}")
        return {}


def _write(data: Dict[str, Any]) -> None:
    directory = os.path.dirname(os.path.abspath(SETTINGS_FILE))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".settings-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass  # Windows: chmod is best-effort
        os.replace(tmp, SETTINGS_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get(name: str) -> Optional[str]:
    """A key or plain setting: stored value first, then its env fallback."""
    value = _read().get(name)
    if isinstance(value, str) and value.strip():
        return value.strip()
    env_name = SECRET_FIELDS.get(name) or PLAIN_FIELDS.get(name)
    if env_name:
        env_value = os.environ.get(env_name, "").strip()
        return env_value or None
    return None


def _merged(name: str, defaults: Dict[str, Any]) -> Dict[str, Any]:
    stored = _read().get(name)
    out = dict(defaults)
    if isinstance(stored, dict):
        out.update({k: v for k, v in stored.items() if k in defaults})
    return out


def publish_defaults() -> Dict[str, Any]:
    return _merged("publish", DEFAULT_PUBLISH)


def autopost() -> Dict[str, Any]:
    return _merged("autopost", DEFAULT_AUTOPOST)


def injected_headers() -> Dict[str, str]:
    """Header name -> stored key, for every key that is set."""
    out = {}
    for field, header in HEADER_FOR_FIELD.items():
        value = get(field)
        if value:
            out[header] = value
    return out


def _mask(value: str) -> str:
    return "••••" + value[-4:] if len(value) > 8 else "••••"


def public_view() -> Dict[str, Any]:
    """What the dashboard may see: never a full key."""
    stored = _read()
    keys = {}
    for field, env_name in SECRET_FIELDS.items():
        own = stored.get(field)
        if isinstance(own, str) and own.strip():
            keys[field] = {"set": True, "source": "server", "hint": _mask(own.strip())}
        elif os.environ.get(env_name, "").strip():
            keys[field] = {"set": True, "source": "env", "hint": _mask(os.environ[env_name].strip())}
        else:
            keys[field] = {"set": False, "source": None, "hint": ""}
    return {
        "keys": keys,
        "postiz_url": get("postiz_url") or "",
        "publish": publish_defaults(),
        "autopost": autopost(),
    }


def _clean_publish(value: Dict[str, Any]) -> Dict[str, Any]:
    out = publish_defaults()
    choices = {
        "youtube_privacy": {"public", "unlisted", "private"},
        "tiktok_privacy": {"PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"},
        "tiktok_method": {"DIRECT_POST", "UPLOAD"},
        "instagram_post_type": {"post", "story"},
    }
    for k, allowed in choices.items():
        if value.get(k) in allowed:
            out[k] = value[k]
    if isinstance(value.get("hashtags"), str):
        out["hashtags"] = value["hashtags"].strip()[:500]
    return out


def _clean_autopost(value: Dict[str, Any]) -> Dict[str, Any]:
    out = autopost()
    if "enabled" in value:
        out["enabled"] = bool(value["enabled"])
    if isinstance(value.get("integration_ids"), list):
        out["integration_ids"] = [str(i) for i in value["integration_ids"] if isinstance(i, (str, int)) and str(i).strip()][:50]
    if value.get("mode") in ("schedule", "draft"):
        out["mode"] = value["mode"]
    for k, lo, hi in (("clips_per_job", 1, 20), ("first_delay_minutes", 0, 7 * 24 * 60)):
        if k in value:
            try:
                out[k] = max(lo, min(hi, int(value[k])))
            except (TypeError, ValueError):
                pass
    if "spacing_hours" in value:
        try:
            out["spacing_hours"] = max(0.0, min(24.0 * 30, float(value["spacing_hours"])))
        except (TypeError, ValueError):
            pass
    return out


def update(changes: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a partial update from the dashboard.

    For keys: a non-empty string replaces the stored key, ``""``/``None``
    deletes it (the env fallback, if any, then applies again), and an absent
    field is left alone.
    """
    with _lock:
        data = _read()
        for field in SECRET_FIELDS:
            if field in changes:
                value = changes[field]
                if isinstance(value, str) and value.strip():
                    data[field] = value.strip()
                else:
                    data.pop(field, None)
        if "postiz_url" in changes:
            url = (changes.get("postiz_url") or "").strip().rstrip("/")
            if url and not url.startswith(("http://", "https://")):
                raise ValueError("Postiz URL must start with http:// or https://")
            if url:
                data["postiz_url"] = url
            else:
                data.pop("postiz_url", None)
        if isinstance(changes.get("publish"), dict):
            data["publish"] = _clean_publish(changes["publish"])
        if isinstance(changes.get("autopost"), dict):
            data["autopost"] = _clean_autopost(changes["autopost"])
        _write(data)
    return public_view()
