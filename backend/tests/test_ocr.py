"""Tests for the two-stage receipt OCR flow.

Stage 1 posts the image to Typhoon's dedicated multipart /ocr endpoint,
which returns raw OCR text. Stage 2 sends that text to a regular chat
model to get our {store, purchased_at, items} schema. Both stages, and
the shape of what they return, were discovered the hard way in
production -- most of these tests pin down a failure that actually
happened.
"""

import json

import httpx

from app.fixtures.sample_receipt import SAMPLE_RECEIPT
from app.routers import ocr as ocr_router
from tests.conftest import FakeTyphoon


class TestMockMode:
    def test_returns_the_fixture(self, client, receipt_upload):
        response = client.post("/ocr/", files=receipt_upload)
        assert response.status_code == 200
        assert response.json() == SAMPLE_RECEIPT

    def test_makes_no_network_calls(self, client, receipt_upload, monkeypatch):
        # Mock mode is what runs without a TYPHOON_API_KEY, so it must not
        # touch the network at all -- not merely avoid needing a valid key.
        def explode(*args, **kwargs):
            raise AssertionError("mock mode must not open an HTTP client")

        monkeypatch.setattr(ocr_router.httpx, "AsyncClient", explode)
        assert client.post("/ocr/", files=receipt_upload).status_code == 200


class TestRealModeRequests:
    """What we actually send to Typhoon."""

    def test_posts_the_image_to_the_dedicated_ocr_endpoint(
        self, client, typhoon, receipt_upload
    ):
        client.post("/ocr/", files=receipt_upload)

        request = typhoon.request_to("/ocr")
        assert request is not None
        assert request.method == "POST"
        # typhoon-ocr is NOT served through /chat/completions -- sending the
        # image there returns "Model not found", which cost a long debugging
        # detour in production.
        assert request.url.path.endswith("/v1/ocr")

    def test_sends_the_image_as_multipart_field_named_file(
        self, client, typhoon, receipt_upload
    ):
        client.post("/ocr/", files=receipt_upload)

        body = typhoon.request_to("/ocr").content
        # The endpoint expects "file"; our own PWA-facing field is "image",
        # so this is an easy place to leak the wrong name through.
        assert b'name="file"' in body
        assert b"fake-jpeg-bytes" in body

    def test_authenticates_both_stages_with_a_bearer_token(
        self, client, typhoon, receipt_upload
    ):
        client.post("/ocr/", files=receipt_upload)

        for suffix in ("/ocr", "/chat/completions"):
            assert typhoon.request_to(suffix).headers["authorization"] == "Bearer sk-test-key-abcd"

    def test_each_stage_uses_its_own_configured_model(self, client, typhoon, receipt_upload):
        client.post("/ocr/", files=receipt_upload)

        assert b"typhoon-ocr" in typhoon.request_to("/ocr").content
        chat_body = json.loads(typhoon.request_to("/chat/completions").content)
        assert chat_body["model"] == ocr_router.TYPHOON_TEXT_MODEL
        assert chat_body["model"] != ocr_router.TYPHOON_OCR_MODEL

    def test_feeds_stage_ones_text_into_stage_twos_prompt(
        self, client, typhoon, receipt_upload
    ):
        typhoon.ocr = httpx.Response(200, json=FakeTyphoon.ocr_body("ไข่ไก่เบอร์0 45.00"))

        client.post("/ocr/", files=receipt_upload)

        prompt = json.loads(typhoon.request_to("/chat/completions").content)["messages"][0][
            "content"
        ]
        assert "ไข่ไก่เบอร์0 45.00" in prompt
        # The prompt embeds a literal JSON skeleton. Building it with
        # str.format() raised KeyError on those braces -- keep them intact.
        assert '{"store"' in prompt


class TestRealModeResponses:
    def test_returns_the_structured_receipt(self, client, typhoon, receipt_upload):
        typhoon.chat = httpx.Response(
            200,
            json=FakeTyphoon.chat_body(
                {
                    "store": "Lotus",
                    "purchased_at": "2026-08-04",
                    "items": [{"id": "1", "raw_text": "ขนมปัง", "price": 29.0}],
                }
            ),
        )

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 200
        assert response.json() == {
            "store": "Lotus",
            "purchased_at": "2026-08-04",
            "items": [{"id": "1", "raw_text": "ขนมปัง", "price": 29.0}],
        }

    def test_unwraps_natural_text_from_stage_ones_json(self, client, typhoon, receipt_upload):
        typhoon.ocr = httpx.Response(200, json=FakeTyphoon.ocr_body("มาม่า 6.00"))

        client.post("/ocr/", files=receipt_upload)

        prompt = json.loads(typhoon.request_to("/chat/completions").content)["messages"][0][
            "content"
        ]
        assert "มาม่า 6.00" in prompt
        assert "natural_text" not in prompt  # the wrapper, not the text

    def test_accepts_stage_one_returning_plain_text(self, client, typhoon, receipt_upload):
        # task_type variants return bare markdown rather than JSON-wrapped
        # text; that must not be mistaken for a failure.
        typhoon.ocr = httpx.Response(
            200,
            json={
                "results": [
                    {
                        "success": True,
                        "message": {"choices": [{"message": {"content": "น้ำดื่ม 7.00"}}]},
                    }
                ]
            },
        )

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 200
        prompt = json.loads(typhoon.request_to("/chat/completions").content)["messages"][0][
            "content"
        ]
        assert "น้ำดื่ม 7.00" in prompt


class TestFailures:
    def test_missing_api_key_with_mock_mode_off_is_a_clear_500(
        self, client, receipt_upload, monkeypatch
    ):
        monkeypatch.setattr(ocr_router, "OCR_MOCK_MODE", False)
        monkeypatch.setattr(ocr_router, "TYPHOON_API_KEY", "")

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 500
        assert "TYPHOON_API_KEY" in response.json()["detail"]

    def test_stage_one_http_error_becomes_502_naming_the_cause(
        self, client, typhoon, receipt_upload
    ):
        typhoon.ocr = httpx.Response(400, json={"detail": "Model not found"})

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 502
        assert "Model not found" in response.json()["detail"]

    def test_stage_one_reporting_failure_per_page_becomes_502(
        self, client, typhoon, receipt_upload
    ):
        # HTTP 200 but success=false: the page-level error is the real one.
        typhoon.ocr = httpx.Response(
            200, json={"results": [{"success": False, "error": "corrupt image"}]}
        )

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 502
        assert "corrupt image" in response.json()["detail"]

    def test_stage_two_http_error_becomes_502_naming_the_cause(
        self, client, typhoon, receipt_upload
    ):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 502
        assert "Model not found" in response.json()["detail"]

    def test_stage_two_returning_non_json_becomes_502(self, client, typhoon, receipt_upload):
        # An instruct model can ignore "respond with ONLY valid JSON".
        typhoon.chat = httpx.Response(
            200, json=FakeTyphoon.chat_body("Sure! Here is the receipt: ...")
        )

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 502
        assert "unparsable" in response.json()["detail"]

    def test_stage_one_is_not_retried_after_stage_two_fails(
        self, client, typhoon, receipt_upload
    ):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})

        client.post("/ocr/", files=receipt_upload)

        ocr_calls = [r for r in typhoon.requests if r.url.path.endswith("/v1/ocr")]
        assert len(ocr_calls) == 1


class TestFailureDiagnostics:
    """A "Model not found" must say which models the key *can* reach.

    Model IDs vary per account and can't be checked against the docs, so
    without this every candidate name costs a deploy.
    """

    def test_logs_the_reachable_model_list(self, client, typhoon, receipt_upload, capsys):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})
        typhoon.models = httpx.Response(
            200, json=[{"id": "typhoon-v2.5-30b-a3b-instruct"}, {"id": "typhoon-ocr"}]
        )

        client.post("/ocr/", files=receipt_upload)

        logs = capsys.readouterr().out
        assert "typhoon-v2.5-30b-a3b-instruct" in logs
        assert "typhoon-ocr" in logs

    def test_logs_config_without_leaking_the_key(self, client, typhoon, receipt_upload, capsys):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})

        client.post("/ocr/", files=receipt_upload)

        logs = capsys.readouterr().out
        assert "sk-test-key-abcd" not in logs  # never the key itself
        assert "key_len=16" in logs
        assert "abcd" in logs  # last 4 only, to spot a stale key

    def test_reports_raw_body_when_the_model_list_shape_is_unfamiliar(
        self, client, typhoon, receipt_upload, capsys
    ):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})
        typhoon.models = httpx.Response(200, json={"unexpected": "shape"})

        client.post("/ocr/", files=receipt_upload)

        assert "unexpected" in capsys.readouterr().out

    def test_accepts_a_bare_list_of_model_ids(self, client, typhoon, receipt_upload, capsys):
        # Typhoon returns a bare list, not OpenAI's {"data": [...]} envelope;
        # assuming the envelope raised AttributeError and logged nothing useful.
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})
        typhoon.models = httpx.Response(200, json=["typhoon-ocr", "typhoon-asr-realtime"])

        client.post("/ocr/", files=receipt_upload)

        assert "typhoon-asr-realtime" in capsys.readouterr().out

    def test_accepts_the_openai_data_envelope(self, client, typhoon, receipt_upload, capsys):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})
        typhoon.models = httpx.Response(200, json={"data": [{"id": "typhoon-ocr"}]})

        client.post("/ocr/", files=receipt_upload)

        assert "typhoon-ocr" in capsys.readouterr().out

    def test_a_broken_model_list_never_masks_the_real_error(
        self, client, typhoon, receipt_upload
    ):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})

        def unreachable():
            raise httpx.ConnectError("models endpoint down")

        typhoon.models = unreachable

        response = client.post("/ocr/", files=receipt_upload)

        # The diagnostic is best-effort; the original failure still surfaces.
        assert response.status_code == 502
        assert "Model not found" in response.json()["detail"]
