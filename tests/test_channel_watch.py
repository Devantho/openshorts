"""Channel watch: feed parsing, publishing slots and the job -> Postiz flow."""
import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import channel_watch as cw  # noqa: E402

PARIS = ZoneInfo("Europe/Paris")
TIMES = cw.parse_times(["07:30", "11:30", "17:30"])

FEED = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <title>Ma Chaine</title>
 <entry>
  <yt:videoId>NEWVIDEO001</yt:videoId>
  <title>Nouvelle vidéo</title>
  <published>2026-10-05T09:00:00+00:00</published>
  <media:group><media:thumbnail url="https://i.ytimg.com/vi/NEWVIDEO001/hqdefault.jpg"/></media:group>
 </entry>
 <entry>
  <yt:videoId>OLDVIDEO001</yt:videoId>
  <title>Ancienne</title>
  <published>2026-09-01T09:00:00+00:00</published>
 </entry>
</feed>"""


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(cw, "STORE_FILE", str(tmp_path / "channels.json"))
    monkeypatch.setattr(cw, "_scheduling", set())
    return tmp_path


def test_parse_times():
    assert [t.strftime("%H:%M") for t in cw.parse_times(["17h30", "7:30", "11:30", "07:30"])] == ["07:30", "11:30", "17:30"]
    with pytest.raises(ValueError):
        cw.parse_times(["25:00"])
    with pytest.raises(ValueError):
        cw.parse_times([])


def test_parse_feed():
    feed = cw.parse_feed(FEED)
    assert feed["title"] == "Ma Chaine"
    assert [v["video_id"] for v in feed["videos"]] == ["NEWVIDEO001", "OLDVIDEO001"]
    assert feed["videos"][0]["thumbnail"].endswith("hqdefault.jpg")
    assert feed["videos"][0]["url"] == "https://www.youtube.com/watch?v=NEWVIDEO001"


def test_free_slots_follow_the_daily_times_in_local_time():
    now = datetime(2026, 10, 5, 8, 0, tzinfo=PARIS).astimezone(timezone.utc)  # Monday 08:00 Paris
    slots = cw.free_slots(5, now, TIMES, PARIS, 7, set())
    local = [s.astimezone(PARIS).strftime("%a %H:%M") for s in slots]
    assert local == ["Mon 11:30", "Mon 17:30", "Tue 07:30", "Tue 11:30", "Tue 17:30"]


def test_free_slots_skip_taken_and_too_close_and_stop_at_the_horizon():
    now = datetime(2026, 10, 5, 11, 25, tzinfo=PARIS).astimezone(timezone.utc)  # 5 min before a slot
    taken = {cw._iso(datetime(2026, 10, 5, 17, 30, tzinfo=PARIS))}
    slots = cw.free_slots(2, now, TIMES, PARIS, 7, taken)
    assert [s.astimezone(PARIS).strftime("%a %H:%M") for s in slots] == ["Tue 07:30", "Tue 11:30"]
    # A one-day window holds at most the 3 next slots.
    assert len(cw.free_slots(50, now, TIMES, PARIS, 1, set())) == 2   # Mon 17:30, Tue 07:30, (Tue 11:30 > 24h)
    assert len(cw.free_slots(50, now, TIMES, PARIS, 7, set())) == 20


def test_free_slots_across_dst_change():
    # 25 Oct 2026: Paris goes from UTC+2 to UTC+1.
    now = datetime(2026, 10, 24, 18, 0, tzinfo=PARIS).astimezone(timezone.utc)
    slots = cw.free_slots(2, now, TIMES, PARIS, 7, set())
    assert [s.astimezone(PARIS).strftime("%d %H:%M") for s in slots] == ["25 07:30", "25 11:30"]
    assert slots[0].strftime("%H:%M") == "06:30"  # UTC after the change


def test_new_uploads_are_clipped_and_scheduled(store, monkeypatch):
    added = datetime(2026, 10, 1, tzinfo=timezone.utc)
    cw._write({**cw._empty(), "channels": [{
        "id": "c1", "channel_id": "UC" + "x" * 22, "title": "Ma Chaine", "url": "",
        "enabled": True, "added_at": cw._iso(added)}]})
    cw._update(lambda d: d["settings"].update(integration_ids=["yt1"]))

    async def fake_feed(channel_id):
        return cw.parse_feed(FEED)

    submitted = []

    async def fake_submit(video, settings):
        submitted.append(video["video_id"])
        return "job-1"

    async def not_short(video_id):
        return False

    monkeypatch.setattr(cw, "fetch_feed", fake_feed)
    monkeypatch.setattr(cw, "submit_video", fake_submit)
    monkeypatch.setattr(cw, "is_short", not_short)

    # Only the upload published after the channel was added is processed.
    asyncio.run(cw.check_channel("c1"))
    assert submitted == ["NEWVIDEO001"]
    assert cw._read()["videos"]["NEWVIDEO001"]["status"] == "processing"
    asyncio.run(cw.check_channel("c1"))
    assert submitted == ["NEWVIDEO001"]          # seen once, never twice

    # The job finishes: clips go to Postiz, best score first, in the slots.
    clips = [{"predicted_score": 10}, {"predicted_score": 90}, {"predicted_score": 50}]
    jobs = {"job-1": {"status": "completed", "result": {"clips": clips}}}
    monkeypatch.setattr(cw, "_get_job", jobs.get)

    async def fake_pick(ids):
        return [{"id": "yt1", "name": "YT", "identifier": "youtube"}]

    posts = []

    async def fake_create(file_path, integrations, title, description, mode="now", date=None, **kw):
        posts.append((title, mode, date))
        return [{"postId": "p"}]

    monkeypatch.setattr(cw.postiz, "pick_integrations", fake_pick)
    monkeypatch.setattr(cw.postiz, "create_post", fake_create)
    monkeypatch.setattr(cw.postiz, "_resolve_media", lambda kind, job_id, i: (f"/tmp/{i}.mp4", f"clip {i}", "d"))

    logs = []
    result = asyncio.run(cw.schedule_job("job-1", logs.append))
    assert [p["clip_index"] for p in result["planned"]] == [1, 2, 0]
    assert [p[0] for p in posts] == ["clip 1", "clip 2", "clip 0"]
    assert all(p[1] == "schedule" for p in posts)
    dates = [p[2] for p in posts]
    assert dates == sorted(dates)
    assert {d.astimezone(PARIS).strftime("%H:%M") for d in dates} <= {"07:30", "11:30", "17:30"}

    data = cw._read()
    assert data["videos"]["NEWVIDEO001"]["status"] == "scheduled"
    assert len(data["slots"]) == 3
    # Idempotent: a second call (poll catch-up) schedules nothing more.
    assert asyncio.run(cw.schedule_job("job-1")) is None
    assert len(posts) == 3

    # A second video takes the following slots, not the same ones.
    cw._update(lambda d: d["videos"].update({"V2": {"video_id": "V2", "job_id": "job-2", "status": "processing"}}))
    jobs["job-2"] = {"status": "completed", "result": {"clips": [{"predicted_score": 1}]}}
    asyncio.run(cw.schedule_job("job-2"))
    assert posts[-1][2] > max(dates)


def test_shorts_are_skipped(store, monkeypatch):
    async def short(video_id):
        return True

    async def never(*a):
        raise AssertionError("must not submit a Short")

    monkeypatch.setattr(cw, "is_short", short)
    monkeypatch.setattr(cw, "submit_video", never)
    channel = {"channel_id": "UC" + "y" * 22, "title": "c"}
    video = {"video_id": "S1", "url": "https://www.youtube.com/watch?v=S1", "title": "s", "published": ""}
    asyncio.run(cw.process_video(channel, video))
    assert cw._read()["videos"]["S1"]["status"] == "skipped"
