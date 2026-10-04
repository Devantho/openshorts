import os
import sys

# Make the repo root importable so tests can import the app modules directly.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Tests always run the app in self-host (BYOK) mode. app.py freezes
# BILLING_ENABLED at import time and load_dotenv never overrides an existing
# variable, so this must be set here — before any test module imports app — or
# the suite's behavior would depend on the developer's personal .env.
os.environ["BILLING_ENABLED"] = "0"

# The panel's password gate (panel_auth.AuthMiddleware) wraps every route and
# replaces client-sent X-*-Key headers with the keys stored server-side. The
# endpoint tests predate it and send their own keys, so outside
# test_panel_auth.py the middleware is a plain pass-through.
import tempfile  # noqa: E402

import pytest  # noqa: E402

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="panel-data-"))


@pytest.fixture(autouse=True)
def _panel_auth_passthrough(request, monkeypatch):
    if request.module.__name__.endswith("test_panel_auth"):
        return
    import panel_auth

    async def passthrough(self, scope, receive, send):
        return await self.app(scope, receive, send)

    monkeypatch.setattr(panel_auth.AuthMiddleware, "__call__", passthrough)
