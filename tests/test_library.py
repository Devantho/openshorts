"""Clips library: /api/library lists every job with its source, newest first."""
import json
import os
import time

import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture()
def jobs(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(app_module, "jobs", {})
    monkeypatch.setattr(app_module.channel_watch, "STORE_FILE", str(tmp_path / "channels.json"))

    def make(job_id, created, url=None, upload=None, status="completed", clips=2, title="Mon_super_podcast"):
        d = tmp_path / job_id
        d.mkdir()
        (d / app_module.SOURCE_SIDECAR).write_text(json.dumps(
            {"url": url, "upload_name": upload, "created_at": created}))
        (d / f"{title}_metadata.json").write_text("{}")
        app_module.jobs[job_id] = {
            "status": status, "output_dir": str(d),
            "result": {"clips": [{"video_url": f"/videos/{job_id}/c{i}.mp4"} for i in range(clips)]},
        }
        return d
    return make


def test_lists_jobs_newest_first_with_their_source(jobs):
    now = time.time()
    jobs("old", now - 3600, upload="talk.mp4", title="talk")
    jobs("new", now, url="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3", clips=3)
    jobs("broken", now - 10, status="failed", clips=0)

    data = TestClient(app_module.app).get("/api/library").json()
    items = data["jobs"]
    assert [i["job_id"] for i in items] == ["new", "old"]      # failed job without clips hidden
    assert items[0]["title"] == "Mon super podcast"
    assert items[0]["thumbnail"] == "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    assert items[0]["clip_count"] == 3
    assert items[1]["upload_name"] == "talk.mp4" and items[1]["thumbnail"] is None
    assert data["retention_seconds"] == app_module.JOB_RETENTION_SECONDS


def test_channel_watch_title_wins(jobs):
    jobs("w1", time.time(), url="https://www.youtube.com/watch?v=AAAAAAAAAAA")
    app_module.channel_watch._write({**app_module.channel_watch._empty(), "videos": {"AAAAAAAAAAA": {
        "video_id": "AAAAAAAAAAA", "job_id": "w1", "title": "Le vrai titre", "channel_title": "Ma chaîne",
        "thumbnail": "https://img/x.jpg", "status": "scheduled", "planned": [{"clip_index": 0}]}}})
    item = TestClient(app_module.app).get("/api/library").json()["jobs"][0]
    assert item["title"] == "Le vrai titre" and item["channel_title"] == "Ma chaîne"
    assert item["thumbnail"] == "https://img/x.jpg" and len(item["scheduled"]) == 1


def test_delete_removes_files_but_not_running_jobs(jobs):
    d = jobs("done", time.time())
    jobs("running", time.time(), status="processing")
    client = TestClient(app_module.app)
    assert client.delete("/api/library/running").status_code == 409
    assert client.delete("/api/library/done").status_code == 200
    assert not os.path.exists(d) and "done" not in app_module.jobs
    assert client.delete("/api/library/nope").status_code == 404
