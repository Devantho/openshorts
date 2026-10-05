"""Channel watch: new YouTube uploads become clips scheduled on Postiz.

The "Chaînes" page lists YouTube channels to follow. A poller reads each
channel's public RSS feed (no API key); every video published after the
channel was added is sent to the clip generator (an in-process POST
/api/process, so keys, quality gate and queue apply unchanged). When the job
completes, its clips, best predicted score first, are scheduled on Postiz in
the next free publishing slots (default 07:30, 11:30 and 17:30 every day, in
the configured timezone) within the next ``horizon_days`` days. Slots are
shared by every followed channel, so two videos never land on the same time.

State lives in ``DATA_DIR/channels.json``. Scheduling is idempotent and also
runs from the poll loop, so a job that finished while the server restarted is
still scheduled.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import threading
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import panel_auth
import postiz
import settings_store

router = APIRouter()

STORE_FILE = os.path.join(settings_store.DATA_DIR, "channels.json")
POLL_SECONDS = int(os.environ.get("CHANNEL_POLL_SECONDS", "900"))
DISABLED = os.environ.get("CHANNEL_WATCH_DISABLED", "").lower() in ("1", "true", "yes")
# A slot closer than this is skipped: the clip still has to upload to Postiz.
MIN_LEAD = timedelta(minutes=10)
# YouTube EU consent wall: without SOCS every request is a 302 to consent.youtube.com.
_YT_COOKIES = {"SOCS": "CAI", "CONSENT": "YES+"}
_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
_ATOM = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
         "media": "http://search.yahoo.com/mrss/"}

DEFAULT_SETTINGS: Dict[str, Any] = {
    "times": ["07:30", "11:30", "17:30"],
    "timezone": "Europe/Paris",
    "horizon_days": 7,          # "dans la semaine": only slots within this window
    "max_clips_per_video": 0,   # 0 = every clip that fits in the window
    "integration_ids": [],      # Postiz channels; empty = the auto-post channels
    "mode": "schedule",         # schedule | draft
    "skip_shorts": True,
    "auto_hook": True,
}

_lock = threading.RLock()
_app = None                                  # the FastAPI app, for in-process calls
_get_job: Callable[[str], Optional[dict]] = lambda job_id: None
_scheduling: set = set()                     # job ids being scheduled right now
_is_active: Callable[[], bool] = lambda: True


# ---- storage -------------------------------------------------------------------

def _empty() -> Dict[str, Any]:
    return {"channels": [], "videos": {}, "slots": {}, "settings": dict(DEFAULT_SETTINGS)}


def _read() -> Dict[str, Any]:
    try:
        with open(STORE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return _empty()
    except (OSError, ValueError) as e:
        print(f"⚠️ Could not read {STORE_FILE}: {e}")
        return _empty()
    base = _empty()
    base.update({k: v for k, v in data.items() if k in base})
    base["settings"] = {**DEFAULT_SETTINGS, **(data.get("settings") or {})}
    return base


def _write(data: Dict[str, Any]) -> None:
    directory = os.path.dirname(os.path.abspath(STORE_FILE))
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".channels-", dir=directory)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, STORE_FILE)


def _update(fn: Callable[[Dict[str, Any]], Any]) -> Any:
    with _lock:
        data = _read()
        result = fn(data)
        _write(data)
        return result


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(value: str) -> Optional[datetime]:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---- publishing slots --------------------------------------------------------------

def parse_times(values: List[str]) -> List[dtime]:
    out = set()
    for v in values or []:
        m = re.fullmatch(r"\s*(\d{1,2})[:hH](\d{2})\s*", str(v))
        if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
            raise ValueError(f"Invalid time: {v!r} (expected HH:MM)")
        out.add(dtime(int(m.group(1)), int(m.group(2))))
    if not out:
        raise ValueError("At least one publishing time is required.")
    return sorted(out)


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError(f"Unknown timezone: {name!r}")


def free_slots(count: int, now: datetime, times: List[dtime], tz: ZoneInfo,
               horizon_days: int, taken: set) -> List[datetime]:
    """The next ``count`` free slots after ``now + MIN_LEAD`` and before
    ``now + horizon_days``, in chronological order (UTC datetimes)."""
    out: List[datetime] = []
    start = now + MIN_LEAD
    end = now + timedelta(days=horizon_days)
    day: date = now.astimezone(tz).date()
    while len(out) < count:
        for t in times:
            local = datetime.combine(day, t, tzinfo=tz)
            # Wall time inside a DST gap: normalise through UTC.
            slot = local.astimezone(timezone.utc)
            if slot > end:
                return out
            if slot < start or _iso(slot) in taken:
                continue
            out.append(slot)
            if len(out) == count:
                return out
        day += timedelta(days=1)
    return out


# ---- YouTube ------------------------------------------------------------------------

_CHANNEL_ID_RE = re.compile(r"^UC[\w-]{22}$")


async def resolve_channel(value: str) -> Dict[str, str]:
    """Channel URL, @handle or UC… id -> {channel_id, title, url}."""
    value = (value or "").strip()
    if not value:
        raise ValueError("Enter a YouTube channel URL, @handle or channel id.")
    channel_id = None
    if _CHANNEL_ID_RE.match(value):
        channel_id = value
    else:
        m = re.search(r"youtube\.com/channel/(UC[\w-]{22})", value)
        if m:
            channel_id = m.group(1)
    if not channel_id:
        if value.startswith("@"):
            page = f"https://www.youtube.com/{value}"
        elif value.startswith("http"):
            page = value
        elif re.fullmatch(r"[\w.-]+", value):
            page = f"https://www.youtube.com/@{value}"
        else:
            raise ValueError("Unrecognised channel. Use https://www.youtube.com/@name or a UC… id.")
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, cookies=_YT_COOKIES,
                                     headers={"User-Agent": _UA, "Accept-Language": "en"}) as client:
            try:
                resp = await client.get(page)
            except httpx.HTTPError as e:
                raise ValueError(f"Could not reach YouTube: {e}")
        if resp.status_code != 200:
            raise ValueError(f"YouTube answered {resp.status_code} for {page}")
        m = (re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[\w-]{22})"', resp.text)
             or re.search(r'"externalId":"(UC[\w-]{22})"', resp.text)
             or re.search(r'"channelId":"(UC[\w-]{22})"', resp.text))
        if not m:
            raise ValueError("No YouTube channel found at that address.")
        channel_id = m.group(1)
    feed = await fetch_feed(channel_id)
    return {"channel_id": channel_id, "title": feed["title"] or channel_id,
            "url": f"https://www.youtube.com/channel/{channel_id}"}


async def fetch_feed(channel_id: str) -> Dict[str, Any]:
    """Latest ~15 uploads from the channel's public RSS feed."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": _UA}) as client:
        resp = await client.get(url)
    if resp.status_code == 404:
        raise ValueError("Channel not found (no public feed).")
    if resp.status_code != 200:
        raise ValueError(f"YouTube feed answered {resp.status_code}")
    return parse_feed(resp.text)


def parse_feed(xml_text: str) -> Dict[str, Any]:
    root = ET.fromstring(xml_text)
    title = (root.findtext("a:title", default="", namespaces=_ATOM) or "").strip()
    videos = []
    for entry in root.findall("a:entry", _ATOM):
        vid = entry.findtext("yt:videoId", default="", namespaces=_ATOM)
        if not vid:
            continue
        thumb = entry.find("media:group/media:thumbnail", _ATOM)
        videos.append({
            "video_id": vid,
            "title": (entry.findtext("a:title", default="", namespaces=_ATOM) or "").strip(),
            "published": entry.findtext("a:published", default="", namespaces=_ATOM),
            "thumbnail": thumb.get("url") if thumb is not None else "",
            "url": f"https://www.youtube.com/watch?v={vid}",
        })
    return {"title": title, "videos": videos}


async def is_short(video_id: str) -> bool:
    """/shorts/<id> answers 200 for a Short and redirects a regular video."""
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False, cookies=_YT_COOKIES,
                                     headers={"User-Agent": _UA}) as client:
            resp = await client.head(f"https://www.youtube.com/shorts/{video_id}")
        return resp.status_code == 200
    except httpx.HTTPError:
        return False


# ---- pipeline ----------------------------------------------------------------------

def _internal_client() -> httpx.AsyncClient:
    if _app is None:
        raise RuntimeError("channel_watch is not wired to the app")
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app),
        base_url="http://bomshort.internal",
        headers={"Authorization": f"Bearer {panel_auth.issue_token()}"},
        timeout=600.0,
    )


async def submit_video(video: Dict[str, Any], settings: Dict[str, Any]) -> str:
    body = {
        "url": video["url"],
        "acknowledged": True,       # the user's own followed channel
        "force_low_quality": True,  # nobody is there to confirm the quality gate
    }
    if settings.get("auto_hook"):
        body.update({"auto_hook": "1", "auto_hook_style": "pill"})
    async with _internal_client() as client:
        resp = await client.post("/api/process", json=body)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = resp.text
        raise RuntimeError(f"/api/process {resp.status_code}: {detail}")
    data = resp.json()
    if not data.get("job_id"):
        raise RuntimeError(f"/api/process returned no job: {data}")
    return data["job_id"]


def _record_video(data, channel, video, status, **extra):
    rec = data["videos"].get(video["video_id"], {})
    rec.update({
        "video_id": video["video_id"], "channel_id": channel["channel_id"],
        "channel_title": channel.get("title", ""), "title": video.get("title", ""),
        "published": video.get("published", ""), "thumbnail": video.get("thumbnail", ""),
        "url": video["url"], "status": status, "updated_at": _iso(_now()),
    })
    rec.setdefault("detected_at", _iso(_now()))
    rec.update(extra)
    data["videos"][video["video_id"]] = rec
    return rec


async def process_video(channel: Dict[str, Any], video: Dict[str, Any]) -> Dict[str, Any]:
    """Send one video to the clip generator and record it."""
    settings = _read()["settings"]
    if settings.get("skip_shorts") and await is_short(video["video_id"]):
        return _update(lambda d: _record_video(d, channel, video, "skipped", error="YouTube Short"))
    try:
        job_id = await submit_video(video, settings)
    except Exception as e:
        print(f"⚠️ Channel watch: could not submit {video['video_id']}: {e}")
        return _update(lambda d: _record_video(d, channel, video, "failed", error=str(e)[:300]))
    print(f"📺 Channel watch: {channel.get('title')} / {video.get('title')} -> job {job_id}")
    return _update(lambda d: _record_video(d, channel, video, "processing", job_id=job_id, error=None))


async def check_channel(channel_id: str, now: Optional[datetime] = None) -> Dict[str, Any]:
    """Read one channel's feed and submit every new upload."""
    now = now or _now()
    data = _read()
    channel = next((c for c in data["channels"] if c["id"] == channel_id), None)
    if channel is None:
        raise KeyError(channel_id)
    try:
        feed = await fetch_feed(channel["channel_id"])
    except Exception as e:
        def fail(d):
            for c in d["channels"]:
                if c["id"] == channel_id:
                    c.update({"last_checked": _iso(now), "last_error": str(e)[:300]})
        _update(fail)
        return {"new": 0, "error": str(e)}

    since = _parse_iso(channel.get("added_at", "")) or now
    fresh = [v for v in feed["videos"]
             if v["video_id"] not in data["videos"]
             and (_parse_iso(v["published"]) or since) > since]

    def ok(d):
        for c in d["channels"]:
            if c["id"] == channel_id:
                c.update({"last_checked": _iso(now), "last_error": None,
                          "title": feed["title"] or c.get("title")})
    _update(ok)

    # Oldest first, so the earliest upload gets the earliest slots.
    for video in sorted(fresh, key=lambda v: v["published"]):
        await process_video(channel, video)
    return {"new": len(fresh)}


# ---- scheduling ---------------------------------------------------------------------

def _score(clip: Dict[str, Any]) -> float:
    s = clip.get("predicted_score")
    return float(s) if isinstance(s, (int, float)) else -1.0


def is_watch_job(job_id: str) -> bool:
    return any(v.get("job_id") == job_id for v in _read()["videos"].values())


async def schedule_job(job_id: str, log: Callable[[str], None] = lambda line: None) -> Optional[Dict[str, Any]]:
    """Schedule the clips of a finished channel-watch job (idempotent)."""
    if job_id in _scheduling:
        return None
    data = _read()
    video = next((v for v in data["videos"].values() if v.get("job_id") == job_id), None)
    if video is None or video.get("status") != "processing":
        return None
    vid = video["video_id"]
    job = _get_job(job_id)
    if not job:
        # Swept from memory (retention) or lost: give up after a while.
        started = _parse_iso(video.get("updated_at", "")) or _now()
        if _now() - started > timedelta(hours=12):
            _update(lambda d: d["videos"][vid].update(status="failed", error="Clip job lost",
                                                       updated_at=_iso(_now())))
        return None
    if job.get("status") not in ("completed", "failed"):
        return None
    if job.get("status") == "failed":
        logs = [str(line) for line in (job.get("logs") or [])]
        reason = next((line for line in reversed(logs) if "rror" in line), "Clip generation failed")
        _update(lambda d: d["videos"][vid].update(status="failed", error=reason[:300],
                                                   updated_at=_iso(_now())))
        return None

    _scheduling.add(job_id)
    try:
        return await _schedule(job_id, vid, (job.get("result") or {}).get("clips") or [], data["settings"], log)
    finally:
        _scheduling.discard(job_id)


async def _schedule(job_id, vid, clips, settings, log):
    def finish(status, **extra):
        _update(lambda d: d["videos"][vid].update(status=status, updated_at=_iso(_now()), **extra))

    if not clips:
        finish("failed", error="No clips were produced")
        return None
    ids = settings.get("integration_ids") or settings_store.autopost().get("integration_ids") or []
    if not ids:
        finish("failed", error="No Postiz channel selected on the Channels page")
        log("⚠️ Channel watch: no Postiz channel selected, clips not scheduled.")
        return None
    try:
        integrations = await postiz.pick_integrations(ids)
        tz = _zone(settings["timezone"])
        times = parse_times(settings["times"])
    except (postiz.PostizError, ValueError) as e:
        msg = getattr(e, "message", str(e))
        finish("failed", error=msg)
        log(f"⚠️ Channel watch: {msg}")
        return None

    ranked = sorted(range(len(clips)), key=lambda i: (-_score(clips[i]), i))
    limit = int(settings.get("max_clips_per_video") or 0)
    if limit > 0:
        ranked = ranked[:limit]

    # Reserve the slots first (under the lock) so a concurrent job cannot take them.
    def reserve(d):
        now = _now()
        d["slots"] = {k: v for k, v in d["slots"].items() if (_parse_iso(k) or now) > now - timedelta(days=1)}
        slots = free_slots(len(ranked), now, times, tz, int(settings["horizon_days"]), set(d["slots"]))
        for slot, index in zip(slots, ranked):
            d["slots"][_iso(slot)] = {"job_id": job_id, "clip_index": index, "video_id": vid, "status": "reserved"}
        return slots
    slots = _update(reserve)

    planned, errors = [], []
    for slot, index in zip(slots, ranked):
        key = _iso(slot)
        try:
            file_path, title, description = await postiz._maybe_await(postiz._resolve_media("clip", job_id, index))
            await postiz.create_post(file_path, integrations, title, description,
                                     mode=settings.get("mode", "schedule"), date=slot)
            planned.append({"clip_index": index, "date": key, "title": title})
            _update(lambda d: d["slots"].get(key, {}).update(status="scheduled", title=title))
            log(f"🗓️ Clip {index + 1} scheduled {slot.astimezone(tz).strftime('%a %d/%m %H:%M')} → "
                f"{', '.join(i['name'] for i in integrations)}")
        except Exception as e:
            msg = getattr(e, "message", None) or getattr(e, "detail", None) or str(e)
            errors.append(f"clip {index + 1}: {msg}")
            _update(lambda d: d["slots"].pop(key, None))
            log(f"⚠️ Clip {index + 1} not scheduled: {msg}")

    skipped = len(ranked) - len(slots)
    if skipped:
        log(f"ℹ️ {skipped} clip(s) not scheduled: no free slot within {settings['horizon_days']} days.")
    finish("scheduled" if planned else "failed", planned=planned, errors=errors,
           unscheduled=skipped, error=None if planned else "; ".join(errors)[:300] or "No free slot")
    return {"planned": planned, "errors": errors, "unscheduled": skipped}


# ---- poll loop ---------------------------------------------------------------------

async def poll_once() -> None:
    data = _read()
    for channel in data["channels"]:
        if channel.get("enabled", True):
            try:
                await check_channel(channel["id"])
            except Exception as e:
                print(f"⚠️ Channel watch: {channel.get('title')}: {e}")
    # Catch up on jobs whose completion hook was missed (restart, crash).
    for video in list(_read()["videos"].values()):
        if video.get("status") == "processing" and video.get("job_id"):
            try:
                await schedule_job(video["job_id"])
            except Exception as e:
                print(f"⚠️ Channel watch: scheduling {video['job_id']}: {e}")


async def _loop() -> None:
    await asyncio.sleep(20)  # let the app finish starting
    while True:
        if _is_active():
            try:
                await poll_once()
            except Exception as e:
                print(f"⚠️ Channel watch loop: {e}")
        await asyncio.sleep(POLL_SECONDS)


def start(app, get_job: Callable[[str], Optional[dict]], is_active: Callable[[], bool] = lambda: True) -> None:
    global _app, _get_job, _is_active
    _app, _get_job, _is_active = app, get_job, is_active
    if DISABLED:
        print("📺 Channel watch disabled (CHANNEL_WATCH_DISABLED).")
        return
    asyncio.create_task(_loop())


# ---- routes -------------------------------------------------------------------------

def _view(data: Dict[str, Any]) -> Dict[str, Any]:
    now = _now()
    videos = sorted(data["videos"].values(), key=lambda v: v.get("detected_at", ""), reverse=True)[:60]
    for v in videos:
        if v.get("status") == "processing" and v.get("job_id"):
            job = _get_job(v["job_id"]) or {}
            v["job_status"] = job.get("status")
    upcoming = sorted(
        ({"date": k, **v} for k, v in data["slots"].items() if (_parse_iso(k) or now) > now),
        key=lambda s: s["date"])
    return {"channels": data["channels"], "videos": videos, "upcoming": upcoming,
            "settings": data["settings"], "poll_seconds": POLL_SECONDS, "disabled": DISABLED}


def _http(e: Exception, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(e))


@router.get("/api/channels")
async def list_channels():
    return _view(_read())


class AddChannel(BaseModel):
    url: str


@router.post("/api/channels")
async def add_channel(req: AddChannel):
    try:
        info = await resolve_channel(req.url)
    except ValueError as e:
        raise _http(e)

    def add(d):
        if any(c["channel_id"] == info["channel_id"] for c in d["channels"]):
            raise ValueError("This channel is already followed.")
        d["channels"].append({"id": uuid.uuid4().hex[:12], **info, "enabled": True,
                              "added_at": _iso(_now()), "last_checked": None, "last_error": None})
    try:
        _update(add)
    except ValueError as e:
        raise _http(e, 409)
    return _view(_read())


class PatchChannel(BaseModel):
    enabled: bool


@router.patch("/api/channels/{channel_id}")
async def patch_channel(channel_id: str, req: PatchChannel):
    def patch(d):
        for c in d["channels"]:
            if c["id"] == channel_id:
                c["enabled"] = req.enabled
                return True
        return False
    if not _update(patch):
        raise HTTPException(status_code=404, detail="Channel not found")
    return _view(_read())


@router.delete("/api/channels/{channel_id}")
async def delete_channel(channel_id: str):
    def drop(d):
        before = len(d["channels"])
        d["channels"] = [c for c in d["channels"] if c["id"] != channel_id]
        return len(d["channels"]) != before
    if not _update(drop):
        raise HTTPException(status_code=404, detail="Channel not found")
    return _view(_read())


@router.post("/api/channels/{channel_id}/check")
async def check_now(channel_id: str):
    try:
        result = await check_channel(channel_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Channel not found")
    return {"result": result, **_view(_read())}


@router.get("/api/channels/{channel_id}/feed")
async def channel_feed(channel_id: str):
    data = _read()
    channel = next((c for c in data["channels"] if c["id"] == channel_id), None)
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        feed = await fetch_feed(channel["channel_id"])
    except ValueError as e:
        raise _http(e, 502)
    for v in feed["videos"]:
        rec = data["videos"].get(v["video_id"])
        v["status"] = rec.get("status") if rec else None
    return {"channel": channel, "videos": feed["videos"]}


class ProcessVideo(BaseModel):
    channel_id: str
    video_id: str


@router.post("/api/channels/process")
async def process_now(req: ProcessVideo):
    """Clip and schedule one feed video by hand (e.g. one posted before the
    channel was followed)."""
    data = _read()
    channel = next((c for c in data["channels"] if c["id"] == req.channel_id), None)
    if channel is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    existing = data["videos"].get(req.video_id)
    if existing and existing.get("status") in ("processing", "scheduled"):
        raise HTTPException(status_code=409, detail="This video is already handled.")
    try:
        feed = await fetch_feed(channel["channel_id"])
    except ValueError as e:
        raise _http(e, 502)
    video = next((v for v in feed["videos"] if v["video_id"] == req.video_id), None)
    if video is None:
        video = {"video_id": req.video_id, "title": req.video_id, "published": "",
                 "thumbnail": "", "url": f"https://www.youtube.com/watch?v={req.video_id}"}
    await process_video(channel, video)
    return _view(_read())


class WatchSettings(BaseModel):
    times: Optional[List[str]] = None
    timezone: Optional[str] = None
    horizon_days: Optional[int] = None
    max_clips_per_video: Optional[int] = None
    integration_ids: Optional[List[str]] = None
    mode: Optional[str] = None
    skip_shorts: Optional[bool] = None
    auto_hook: Optional[bool] = None


@router.put("/api/channels/settings")
async def put_settings(req: WatchSettings):
    changes: Dict[str, Any] = {}
    try:
        if req.times is not None:
            changes["times"] = [t.strftime("%H:%M") for t in parse_times(req.times)]
        if req.timezone is not None:
            _zone(req.timezone)
            changes["timezone"] = req.timezone
    except ValueError as e:
        raise _http(e)
    if req.horizon_days is not None:
        changes["horizon_days"] = max(1, min(30, req.horizon_days))
    if req.max_clips_per_video is not None:
        changes["max_clips_per_video"] = max(0, min(50, req.max_clips_per_video))
    if req.integration_ids is not None:
        changes["integration_ids"] = [str(i) for i in req.integration_ids][:50]
    if req.mode in ("schedule", "draft"):
        changes["mode"] = req.mode
    if req.skip_shorts is not None:
        changes["skip_shorts"] = req.skip_shorts
    if req.auto_hook is not None:
        changes["auto_hook"] = req.auto_hook
    _update(lambda d: d["settings"].update(changes))
    return _view(_read())
