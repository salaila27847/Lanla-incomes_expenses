"""Tests for the transfer-slip OCR flow (POST /ocr/slip).

Shares stage 1 (raw OCR text) and its diagnostics with the receipt flow --
see test_ocr.py -- so this only covers what's actually different: the slip
schema has no items, and its own structuring prompt.
"""

import json

import httpx

from app.fixtures.sample_slip import SAMPLE_SLIP
from app.routers import ocr as ocr_router
from tests.conftest import FakeTyphoon


class TestMockMode:
    def test_returns_the_fixture(self, client, receipt_upload):
        response = client.post("/ocr/slip", files=receipt_upload)

        assert response.status_code == 200
        assert response.json() == SAMPLE_SLIP

    def test_makes_no_network_calls(self, client, receipt_upload, monkeypatch):
        def explode(*args, **kwargs):
            raise AssertionError("mock mode must not open an HTTP client")

        monkeypatch.setattr(ocr_router.httpx, "AsyncClient", explode)
        assert client.post("/ocr/slip", files=receipt_upload).status_code == 200


class TestRealModeRequests:
    def test_posts_the_image_to_the_same_dedicated_ocr_endpoint(
        self, client, typhoon, receipt_upload
    ):
        client.post("/ocr/slip", files=receipt_upload)

        request = typhoon.request_to("/ocr")
        assert request is not None
        assert request.url.path.endswith("/v1/ocr")

    def test_uses_the_slip_prompt_not_the_receipt_one(self, client, typhoon, receipt_upload):
        typhoon.ocr = httpx.Response(200, json=FakeTyphoon.ocr_body("โอนเงินสำเร็จ 55.00"))

        client.post("/ocr/slip", files=receipt_upload)

        prompt = json.loads(typhoon.request_to("/chat/completions").content)["messages"][0][
            "content"
        ]
        assert "โอนเงินสำเร็จ 55.00" in prompt
        assert '{"payee"' in prompt
        assert "items" not in prompt  # would push the model to invent a list

    def test_authenticates_both_stages_with_a_bearer_token(
        self, client, typhoon, receipt_upload
    ):
        client.post("/ocr/slip", files=receipt_upload)

        for suffix in ("/ocr", "/chat/completions"):
            assert typhoon.request_to(suffix).headers["authorization"] == "Bearer sk-test-key-abcd"


class TestRealModeResponses:
    def scan(self, client, typhoon, receipt_upload, parsed):
        typhoon.chat = httpx.Response(200, json=FakeTyphoon.chat_body(parsed))
        return client.post("/ocr/slip", files=receipt_upload)

    def test_returns_the_structured_slip(self, client, typhoon, receipt_upload):
        response = self.scan(
            client, typhoon, receipt_upload,
            {
                "payee": "ร้านถุงเงิน (แซ่บเล้ง แอนด์ หม่าล่านายเบิร์ด)",
                "purchased_at": "2026-08-17",
                "amount": 55.0,
                "transaction_id": "0462295o93a70vtnAtxx",
            },
        )

        assert response.status_code == 200
        assert response.json() == {
            "payee": "ร้านถุงเงิน (แซ่บเล้ง แอนด์ หม่าล่านายเบิร์ด)",
            "purchased_at": "2026-08-17",
            "amount": 55.0,
            "transaction_id": "0462295o93a70vtnAtxx",
        }

    def test_rounds_the_amount_to_two_decimals(self, client, typhoon, receipt_upload):
        response = self.scan(
            client, typhoon, receipt_upload,
            {"payee": "ร้านค้า", "purchased_at": None, "amount": 55.006, "transaction_id": None},
        )

        assert response.json()["amount"] == 55.01

    def test_an_unparsable_amount_becomes_zero_rather_than_crashing(
        self, client, typhoon, receipt_upload
    ):
        response = self.scan(
            client, typhoon, receipt_upload,
            {"payee": "ร้านค้า", "purchased_at": None, "amount": "??", "transaction_id": None},
        )

        assert response.status_code == 200
        assert response.json()["amount"] == 0.0

    def test_a_missing_payee_is_null_not_an_error(self, client, typhoon, receipt_upload):
        response = self.scan(
            client, typhoon, receipt_upload,
            {"payee": None, "purchased_at": None, "amount": 10.0, "transaction_id": None},
        )

        assert response.json()["payee"] is None


class TestFailures:
    def test_missing_api_key_with_mock_mode_off_is_a_clear_500(
        self, client, receipt_upload, monkeypatch
    ):
        monkeypatch.setattr(ocr_router, "OCR_MOCK_MODE", False)
        monkeypatch.setattr(ocr_router, "TYPHOON_API_KEY", "")

        response = client.post("/ocr/slip", files=receipt_upload)

        assert response.status_code == 500
        assert "TYPHOON_API_KEY" in response.json()["detail"]

    def test_stage_one_http_error_becomes_502(self, client, typhoon, receipt_upload):
        typhoon.ocr = httpx.Response(400, json={"detail": "Model not found"})

        response = client.post("/ocr/slip", files=receipt_upload)

        assert response.status_code == 502
        assert "Model not found" in response.json()["detail"]

    def test_stage_two_http_error_becomes_502(self, client, typhoon, receipt_upload):
        typhoon.chat = httpx.Response(400, json={"detail": "Model not found"})

        response = client.post("/ocr/slip", files=receipt_upload)

        assert response.status_code == 502
        assert "Model not found" in response.json()["detail"]

    def test_stage_two_returning_non_json_becomes_502(self, client, typhoon, receipt_upload):
        typhoon.chat = httpx.Response(
            200, json=FakeTyphoon.chat_body("Sure! Here is the slip: ...")
        )

        response = client.post("/ocr/slip", files=receipt_upload)

        assert response.status_code == 502
        assert "unparsable" in response.json()["detail"]
