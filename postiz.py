"""Publishing through a self-hosted Postiz instance (public API v1).

Replaces Upload-Post for this panel. Postiz holds the social accounts
("integrations" / channels); this module uploads a rendered clip once and
creates one post group targeting every selected channel, immediately, at a
scheduled date, or as a draft to review inside Postiz.

API reference: https://docs.postiz.com/public-api
  GET  /integrations      -> [{id, name, identifier, picture, disabled, profile}]
  POST /upload            multipart "file" -> {id, path, ...}
  POST /posts             {type, date, shortLink, tags, posts: [...]}

``app.py`` wires two things in: ``configure(resolve_media=...)`` which maps a
clip reference to a file on disk, and ``autopost_job`` which it calls when a
clip job completes.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import settings_store

router = APIRouter()

# (kind, job_id, clip_index) -> (file_path, default_title, default_description)
MediaResolver = Callable[[str, str, Optional[int]], Tuple[str, str, str]]
_resolve_media: Optional[MediaResolver] = None

UPLOAD_TIMEOUT = float(os.environ.get("POSTIZ_UPLOAD_TIMEOUT", "600"))


def configure(resolve_media: MediaResolver) -> None:
    global _resolve_media
    _resolve_media = resolve_media


class PostizError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def api_base(url: str) -> str:
    """Accept the Postiz app URL, its backend URL or the full public API URL.

    https://postiz.example.com              -> .../api/public/v1
    https://postiz.example.com/api          -> .../api/public/v1
    https://postiz.example.com/api/public/v1 (as-is)
    """
    url = (url or "").strip().rstrip("/")
    if url.endswith("/public/v1"):
        return url
    if url.endswith("/api"):
        return url + "/public/v1"
    return url + "/api/public/v1"


def _client_config() -> Tuple[str, str]:
    url = settings_store.get("postiz_url")
    key = settings_store.get("postiz_api_key")
    if not url or not key:
        raise PostizError(400, "Postiz is not configured. Set the Postiz URL and API key in Settings.")
    return api_base(url), key


def _error_text(resp: httpx.Response) -> str:
    try:
        body = resp.json()
        if isinstance(body, dict):
            msg = body.get("message") or body.get("error") or body.get("msg")
            if isinstance(msg, list):
                msg = "; ".join(str(m) for m in msg)
            if msg:
                return str(msg)[:500]
    except ValueError:
        pass
    return (resp.text or resp.reason_phrase or "error")[:500]


async def list_integrations() -> List[Dict[str, Any]]:
    base, key = _client_config()
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.get(f"{base}/integrations", headers={"Authorization": key})
        except httpx.HTTPError as e:
            raise PostizError(502, f"Could not reach Postiz at {base}: {e}")
    if resp.status_code != 200:
        raise PostizError(resp.status_code if resp.status_code < 500 else 502,
                          f"Postiz answered {resp.status_code}: {_error_text(resp)}")
    data = resp.json()
    items = data if isinstance(data, list) else (data.get("integrations") or [])
    out = []
    for it in items:
        if not isinstance(it, dict) or not it.get("id"):
            continue
        out.append({
            "id": it.get("id"),
            "name": it.get("name") or it.get("profile") or it.get("identifier"),
            "identifier": it.get("identifier") or it.get("providerIdentifier") or "",
            "picture": it.get("picture") or "",
            "disabled": bool(it.get("disabled")),
            "profile": it.get("profile") or "",
        })
    return out


_MIME = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
         ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


def _upload_blocking(base: str, key: str, file_path: str) -> Dict[str, Any]:
    filename = os.path.basename(file_path)
    mime = _MIME.get(os.path.splitext(filename)[1].lower(), "application/octet-stream")
    with open(file_path, "rb") as f, httpx.Client(timeout=UPLOAD_TIMEOUT) as client:
        resp = client.post(f"{base}/upload", headers={"Authorization": key},
                           files={"file": (filename, f, mime)})
    if resp.status_code not in (200, 201):
        raise PostizError(resp.status_code if resp.status_code < 500 else 502,
                          f"Postiz upload failed ({resp.status_code}): {_error_text(resp)}")
    body = resp.json()
    if not body.get("path"):
        raise PostizError(502, "Postiz upload returned no media path.")
    return {"id": body.get("id") or "", "path": body["path"]}


async def upload_media(file_path: str) -> Dict[str, Any]:
    base, key = _client_config()
    return await asyncio.to_thread(_upload_blocking, base, key, file_path)


def _tags(text: str) -> List[Dict[str, str]]:
    words = [w.lstrip("#").strip() for w in (text or "").replace(",", " ").split()]
    return [{"value": w, "label": w} for w in words if w][:15]


def provider_settings(identifier: str, title: str, opts: Dict[str, Any]) -> Dict[str, Any]:
    """The ``settings`` block Postiz requires for a video on each provider."""
    ident = (identifier or "").lower()
    if ident == "youtube":
        return {"__type": "youtube", "title": (title or "Short")[:100], "type": opts.get("youtube_privacy", "public"),
                "selfDeclaredMadeForKids": "no", "thumbnail": None, "tags": _tags(opts.get("hashtags", ""))}
    if ident == "tiktok":
        return {"__type": "tiktok", "title": (title or "")[:90], "privacy_level": opts.get("tiktok_privacy", "PUBLIC_TO_EVERYONE"),
                "duet": False, "stitch": False, "comment": True, "autoAddMusic": "no",
                "brand_content_toggle": False, "brand_organic_toggle": False, "video_made_with_ai": False,
                "content_posting_method": opts.get("tiktok_method", "DIRECT_POST")}
    if ident in ("instagram", "instagram-standalone"):
        return {"__type": ident, "post_type": opts.get("instagram_post_type", "post"), "collaborators": []}
    if ident == "x":
        return {"__type": "x", "who_can_reply_post": "everyone"}
    if ident in ("linkedin", "linkedin-page"):
        return {"__type": ident, "post_as_images_carousel": False}
    if ident == "pinterest":
        return {"__type": "pinterest", "title": (title or "")[:100]}
    return {"__type": ident}


def _with_thumbnail(settings: Dict[str, Any], thumbnail: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if thumbnail and settings.get("__type") == "youtube":
        settings["thumbnail"] = thumbnail
    return settings


def _compose_text(description: str, hashtags: str) -> str:
    text = (description or "").strip()
    tags = " ".join(("#" + t.lstrip("#")) for t in (hashtags or "").replace(",", " ").split() if t.strip("#"))
    if tags and tags not in text:
        text = (text + "\n\n" + tags).strip()
    return text


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


async def create_post(file_path: str, integrations: List[Dict[str, Any]], title: str, description: str,
                      mode: str = "now", date: Optional[datetime] = None,
                      opts: Optional[Dict[str, Any]] = None, thumbnail_path: Optional[str] = None) -> Any:
    """Upload ``file_path`` once and publish it on every channel in ``integrations``.

    ``thumbnail_path``: custom cover image, used by YouTube channels.
    """
    if not integrations:
        raise PostizError(400, "Select at least one Postiz channel.")
    if mode not in ("now", "schedule", "draft"):
        raise PostizError(400, "mode must be now, schedule or draft")
    opts = {**settings_store.publish_defaults(), **(opts or {})}
    media = await upload_media(file_path)
    thumbnail = await upload_media(thumbnail_path) if thumbnail_path else None
    text = _compose_text(description, opts.get("hashtags", ""))
    when = date or datetime.now(timezone.utc)
    payload = {
        "type": mode,
        "date": _iso(when),
        "shortLink": False,
        "tags": [],
        "posts": [{
            "integration": {"id": it["id"]},
            "value": [{"content": text, "image": [media]}],
            "settings": _with_thumbnail(provider_settings(it.get("identifier", ""), title, opts), thumbnail),
        } for it in integrations],
    }
    base, key = _client_config()
    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            resp = await client.post(f"{base}/posts", headers={"Authorization": key, "Content-Type": "application/json"},
                                     json=payload)
        except httpx.HTTPError as e:
            raise PostizError(502, f"Could not reach Postiz: {e}")
    if resp.status_code not in (200, 201):
        raise PostizError(resp.status_code if resp.status_code < 500 else 502,
                          f"Postiz refused the post ({resp.status_code}): {_error_text(resp)}")
    try:
        return resp.json()
    except ValueError:
        return {"ok": True}


async def pick_integrations(ids: List[str]) -> List[Dict[str, Any]]:
    available = {it["id"]: it for it in await list_integrations()}
    picked = [available[i] for i in ids if i in available and not available[i]["disabled"]]
    if not picked:
        raise PostizError(400, "None of the selected Postiz channels is available (deleted or disabled?).")
    return picked


def parse_date(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise PostizError(400, "scheduled_date must be an ISO-8601 date")
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---- routes -------------------------------------------------------------------

def _http(e: PostizError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.message)


@router.get("/api/postiz/integrations")
async def postiz_integrations():
    try:
        return {"integrations": await list_integrations()}
    except PostizError as e:
        raise _http(e)


class PostizPostRequest(BaseModel):
    kind: str = "clip"                  # clip | saas
    job_id: str
    clip_index: Optional[int] = None
    integration_ids: List[str]
    title: Optional[str] = None
    description: Optional[str] = None
    mode: str = "now"                   # now | schedule | draft
    scheduled_date: Optional[str] = None
    options: Optional[Dict[str, Any]] = None  # overrides of the publish defaults


@router.post("/api/postiz/post")
async def postiz_post(req: PostizPostRequest):
    if _resolve_media is None:
        raise HTTPException(status_code=503, detail="Publishing is not wired.")
    file_path, default_title, default_description = await _maybe_await(
        _resolve_media(req.kind, req.job_id, req.clip_index))
    try:
        date = parse_date(req.scheduled_date)
        if req.mode == "schedule" and date is None:
            raise PostizError(400, "A scheduled post needs scheduled_date.")
        integrations = await pick_integrations(req.integration_ids)
        opts = {k: v for k, v in (req.options or {}).items()
                if k in settings_store.DEFAULT_PUBLISH and isinstance(v, str)}
        result = await create_post(file_path, integrations, req.title or default_title,
                                   req.description if req.description is not None else default_description,
                                   mode=req.mode, date=date, opts=opts)
    except PostizError as e:
        raise _http(e)
    print(f"📡 Postiz: {req.kind} {req.job_id}#{req.clip_index} -> {len(integrations)} channel(s), {req.mode}")
    return {"success": True, "channels": [i["name"] for i in integrations], "result": result}


async def _maybe_await(value):
    if asyncio.iscoroutine(value):
        return await value
    return value


# ---- automatic publishing -----------------------------------------------------

def _score(clip: Dict[str, Any]) -> float:
    s = clip.get("predicted_score")
    return float(s) if isinstance(s, (int, float)) else -1.0


async def autopost_job(job_id: str, clips: List[Dict[str, Any]], log: Callable[[str], None]) -> Optional[Dict[str, Any]]:
    """Publish the best clips of a finished job according to the autopost settings.

    Returns a summary (also written to the job's logs) or None when disabled.
    """
    cfg = settings_store.autopost()
    if not cfg.get("enabled") or not cfg.get("integration_ids") or not clips:
        return None
    if _resolve_media is None:
        return None
    try:
        integrations = await pick_integrations(cfg["integration_ids"])
    except PostizError as e:
        log(f"⚠️ Auto-post skipped: {e.message}")
        return {"posted": 0, "errors": [e.message]}

    ranked = sorted(range(len(clips)), key=lambda i: (-_score(clips[i]), i))[: int(cfg["clips_per_job"])]
    start = datetime.now(timezone.utc) + timedelta(minutes=int(cfg["first_delay_minutes"]))
    spacing = timedelta(hours=float(cfg["spacing_hours"]))
    mode = cfg["mode"]
    posted, errors, planned = 0, [], []
    for n, index in enumerate(ranked):
        when = start + spacing * n
        try:
            file_path, title, description = await _maybe_await(_resolve_media("clip", job_id, index))
            await create_post(file_path, integrations, title, description, mode=mode, date=when)
            posted += 1
            planned.append({"clip_index": index, "date": _iso(when)})
            log(f"📡 Auto-post: clip {index + 1} → {', '.join(i['name'] for i in integrations)}"
                f" ({'draft' if mode == 'draft' else when.strftime('%Y-%m-%d %H:%M UTC')})")
        except HTTPException as e:
            errors.append(f"clip {index + 1}: {e.detail}")
            log(f"⚠️ Auto-post failed for clip {index + 1}: {e.detail}")
        except PostizError as e:
            errors.append(f"clip {index + 1}: {e.message}")
            log(f"⚠️ Auto-post failed for clip {index + 1}: {e.message}")
        except Exception as e:  # never let publishing break the job
            errors.append(f"clip {index + 1}: {e}")
            log(f"⚠️ Auto-post failed for clip {index + 1}: {e}")
    return {"posted": posted, "planned": planned, "errors": errors, "mode": mode}
