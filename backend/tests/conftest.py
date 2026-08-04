"""Shared fixtures.

`app.config` reads os.environ at import time and the routers then import
those values *by value* (`from app.config import OCR_MOCK_MODE`), so a
test that wants different config has to patch the attribute on the router
module, not the environment. The `typhoon` fixture below does that for
the OCR router; `reload_config` covers the config module itself.
"""

import json
import os

# Must happen before any `app.*` import so a developer's real .env or
# exported TYPHOON_API_KEY can't change what the suite sees.
os.environ.pop("TYPHOON_API_KEY", None)
os.environ["OCR_MOCK_MODE"] = "true"

import httpx  # noqa: E402
import pytest  # noqa: E402

from app.routers import ocr as ocr_router  # noqa: E402


class FakeTyphoon:
    """Stands in for the Typhoon API.

    Tests set `.ocr`, `.chat` and `.models` to the response each endpoint
    should return, and read `.requests` to assert on what was sent.
    """

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.ocr = httpx.Response(200, json=self.ocr_body("7-Eleven\nนมสด 15.00"))
        self.chat = httpx.Response(200, json=self.chat_body())
        self.models = httpx.Response(200, json=[{"id": "typhoon-ocr"}])

    @staticmethod
    def ocr_body(natural_text: str) -> dict:
        """The nested shape Typhoon's /ocr endpoint actually returns."""
        return {
            "results": [
                {
                    "success": True,
                    "filename": "receipt.jpg",
                    "message": {
                        "choices": [
                            {"message": {"content": json.dumps({"natural_text": natural_text})}}
                        ]
                    },
                }
            ]
        }

    @staticmethod
    def chat_body(content: dict | str | None = None) -> dict:
        if content is None:
            content = {
                "store": "7-Eleven",
                "purchased_at": "2026-08-04",
                "items": [{"id": "1", "raw_text": "นมสด", "price": 15.0}],
            }
        return {
            "choices": [
                {
                    "message": {
                        "content": content if isinstance(content, str) else json.dumps(content)
                    }
                }
            ]
        }

    def request_to(self, path_suffix: str) -> httpx.Request | None:
        for request in self.requests:
            if request.url.path.endswith(path_suffix):
                return request
        return None

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/ocr"):
            return self._resolve(self.ocr)
        if path.endswith("/chat/completions"):
            return self._resolve(self.chat)
        if path.endswith("/models"):
            return self._resolve(self.models)
        return httpx.Response(404, json={"detail": f"unexpected path {path}"})

    @staticmethod
    def _resolve(response):
        # Allow a callable to raise (connection errors) instead of responding.
        return response() if callable(response) else response


@pytest.fixture
def typhoon(monkeypatch):
    """Route the OCR router's HTTP calls to a FakeTyphoon, real API off.

    Also flips OCR_MOCK_MODE off and supplies a key, since every test that
    wants the fake is by definition exercising the real-API path.
    """
    fake = FakeTyphoon()

    class _MockedClient(httpx.AsyncClient):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(fake._handle)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(ocr_router.httpx, "AsyncClient", _MockedClient)
    monkeypatch.setattr(ocr_router, "OCR_MOCK_MODE", False)
    monkeypatch.setattr(ocr_router, "TYPHOON_API_KEY", "sk-test-key-abcd")
    return fake


@pytest.fixture
def client():
    """TestClient over the same app Vercel serves (api/index.py)."""
    from fastapi.testclient import TestClient

    import api.index

    return TestClient(api.index.app)


@pytest.fixture
def receipt_upload():
    return {"image": ("receipt.jpg", b"fake-jpeg-bytes", "image/jpeg")}
