"""Panel password auth, server-side key storage and Postiz payloads.

Runs against panel_auth / settings_store / postiz directly with a tiny ASGI
app, so it needs neither the GPU pipeline nor app.py's heavy imports.
"""
import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def mods(tmp_path, monkeypatch):
    """The three modules, pointed at a fresh data dir (no reload: app.py holds
    references to them for the rest of the session)."""
    for name in ("APP_PASSWORD", "APP_SECRET", "APP_API_TOKEN", "GEMINI_API_KEY",
                 "POSTIZ_URL", "POSTIZ_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    import settings_store
    import panel_auth
    import postiz
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(panel_auth, "AUTH_FILE", str(tmp_path / "auth.json"))
    monkeypatch.setattr(panel_auth, "_attempts", {})
    monkeypatch.setattr(postiz, "_resolve_media", postiz._resolve_media)
    return settings_store, panel_auth, postiz


def _call(app, path, headers=None):
    """Run one GET through an ASGI app, return (status, seen_headers)."""
    seen = {}
    sent = {}

    async def inner(scope, receive, send):
        seen.update({k.decode(): v.decode() for k, v in scope["headers"]})
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(msg):
        if msg["type"] == "http.response.start":
            sent["status"] = msg["status"]

    scope = {"type": "http", "method": "GET", "path": path,
             "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]}
    asyncio.run(app(inner)(scope, receive, send) if callable(app) else None)
    return sent["status"], seen


def test_generated_password_and_session(mods, capsys):
    _, auth, _ = mods
    auth.ensure_initialised()
    out = capsys.readouterr().out
    password = out.split("Generated panel password: ")[1].split()[0]
    assert auth.check_password(password)
    assert not auth.check_password("nope")
    token = auth.issue_token()
    assert auth.verify_token(token)
    assert not auth.verify_token(token[:-2] + "xx")
    # Changing the password voids existing sessions.
    auth.change_password(password, "a-new-password")
    assert not auth.verify_token(token)
    assert auth.check_password("a-new-password")


def test_env_password(mods, monkeypatch):
    _, auth, _ = mods
    monkeypatch.setenv("APP_PASSWORD", "hunter22")
    assert auth.check_password("hunter22")
    with pytest.raises(PermissionError):
        auth.change_password("hunter22", "something-else")


def test_middleware_blocks_and_injects_keys(mods):
    store, auth, _ = mods
    auth.ensure_initialised()
    store.update({"gemini_api_key": "AIza-server-key-1234"})
    mw = auth.AuthMiddleware

    status, _ = _call(mw, "/api/process")
    assert status == 401
    status, _ = _call(mw, "/videos/job/clip.mp4")
    assert status == 401
    status, _ = _call(mw, "/health")
    assert status == 200

    cookie = f"{auth.COOKIE_NAME}={auth.issue_token()}"
    status, seen = _call(mw, "/api/process", {"Cookie": cookie, "X-Gemini-Key": "client-key"})
    assert status == 200
    assert seen["x-gemini-key"] == "AIza-server-key-1234"  # the client's header is replaced


def test_api_token(mods, monkeypatch):
    _, auth, _ = mods
    monkeypatch.setenv("APP_API_TOKEN", "agent-token-xyz")
    status, _ = _call(auth.AuthMiddleware, "/mcp", {"Authorization": "Bearer agent-token-xyz"})
    assert status == 200


def test_settings_never_expose_keys(mods, tmp_path):
    store, _, _ = mods
    view = store.update({"gemini_api_key": "AIzaSECRETVALUE9876", "postiz_url": "https://postiz.example.com/"})
    blob = json.dumps(view)
    assert "SECRETVALUE" not in blob
    assert view["keys"]["gemini_api_key"] == {"set": True, "source": "server", "hint": "••••9876"}
    assert view["postiz_url"] == "https://postiz.example.com"
    assert store.get("gemini_api_key") == "AIzaSECRETVALUE9876"
    view = store.update({"gemini_api_key": ""})
    assert view["keys"]["gemini_api_key"]["set"] is False
    with pytest.raises(ValueError):
        store.update({"postiz_url": "javascript:alert(1)"})


def test_autopost_settings_are_clamped(mods):
    store, _, _ = mods
    view = store.update({"autopost": {"enabled": True, "clips_per_job": 999, "spacing_hours": -3,
                                      "integration_ids": ["a", "b"], "mode": "bogus"}})
    ap = view["autopost"]
    assert ap["enabled"] is True and ap["clips_per_job"] == 20 and ap["spacing_hours"] == 0
    assert ap["integration_ids"] == ["a", "b"] and ap["mode"] == "schedule"


def test_postiz_upload_then_post(mods, tmp_path, monkeypatch):
    import httpx
    store, _, pz = mods
    store.update({"postiz_url": "https://pz.example.com", "postiz_api_key": "pz-key",
                  "publish": {"hashtags": "#shorts"}})
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00" * 64)
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["authorization"] == "pz-key"
        if request.url.path.endswith("/integrations"):
            return httpx.Response(200, json=[
                {"id": "yt1", "name": "My channel", "identifier": "youtube", "disabled": False},
                {"id": "tt1", "name": "My tiktok", "identifier": "tiktok", "disabled": False},
                {"id": "off", "name": "Old", "identifier": "x", "disabled": True}])
        if request.url.path.endswith("/upload"):
            return httpx.Response(201, json={"id": "m1", "path": "https://pz.example.com/uploads/clip.mp4"})
        if request.url.path.endswith("/posts"):
            return httpx.Response(201, json=[{"postId": "p1"}])
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    real_client, real_async = httpx.Client, httpx.AsyncClient
    monkeypatch.setattr(httpx, "Client", lambda **kw: real_client(transport=transport, **kw))
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_async(transport=transport, **kw))

    pz.configure(lambda kind, job_id, idx: (str(clip), f"Title {idx}", "Desc"))
    store.update({"autopost": {"enabled": True, "integration_ids": ["yt1", "tt1", "off"], "clips_per_job": 2}})
    logs = []
    clips = [{"predicted_score": 10}, {"predicted_score": 90}, {"predicted_score": 50}]
    summary = asyncio.run(pz.autopost_job("job1", clips, logs.append))
    assert summary["posted"] == 2 and not summary["errors"]
    assert [p["clip_index"] for p in summary["planned"]] == [1, 2]   # best scores first

    post = json.loads([c for c in calls if c.url.path.endswith("/posts")][0].content)
    assert post["type"] == "schedule"
    assert [p["integration"]["id"] for p in post["posts"]] == ["yt1", "tt1"]   # disabled one dropped
    assert post["posts"][0]["settings"]["__type"] == "youtube"
    assert post["posts"][0]["value"][0]["image"] == [{"id": "m1", "path": "https://pz.example.com/uploads/clip.mp4"}]
    assert post["posts"][0]["value"][0]["content"] == "Desc\n\n#shorts"


def test_postiz_base_url_and_settings(mods):
    _, _, pz = mods
    assert pz.api_base("https://p.example.com") == "https://p.example.com/api/public/v1"
    assert pz.api_base("https://p.example.com/api/") == "https://p.example.com/api/public/v1"
    assert pz.api_base("https://p.example.com/api/public/v1") == "https://p.example.com/api/public/v1"
    yt = pz.provider_settings("youtube", "My title", {"youtube_privacy": "unlisted", "hashtags": "#a b"})
    assert yt["__type"] == "youtube" and yt["type"] == "unlisted"
    assert yt["tags"] == [{"value": "a", "label": "a"}, {"value": "b", "label": "b"}]
    tt = pz.provider_settings("tiktok", "t", {})
    assert tt["privacy_level"] == "PUBLIC_TO_EVERYONE" and tt["content_posting_method"] == "DIRECT_POST"
    assert pz._compose_text("hello", "#x y") == "hello\n\n#x #y"
