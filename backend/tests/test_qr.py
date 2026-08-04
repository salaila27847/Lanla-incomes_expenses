"""The savings-transfer QR endpoint.

The PromptPay ID is a backend-only secret: the PWA sends an amount and
nothing else, so the endpoint has to supply the destination itself.
"""

import base64

from app.promptpay import build_promptpay_payload
from app.routers import qr as qr_router

CONFIGURED_ID = "0899999999"


def test_generates_a_qr_for_the_configured_savings_account(client, monkeypatch):
    monkeypatch.setattr(qr_router, "SAVINGS_PROMPTPAY_ID", CONFIGURED_ID)

    body = client.post("/qr/", json={"amount_thb": 250}).json()

    assert body["payload"] == build_promptpay_payload(CONFIGURED_ID, 250)
    assert body["qr_data_url"].startswith("data:image/png;base64,")


def test_the_data_url_decodes_to_a_real_png(client, monkeypatch):
    monkeypatch.setattr(qr_router, "SAVINGS_PROMPTPAY_ID", CONFIGURED_ID)

    data_url = client.post("/qr/", json={"amount_thb": 10}).json()["qr_data_url"]

    image = base64.b64decode(data_url.split(",", 1)[1])
    assert image.startswith(b"\x89PNG\r\n\x1a\n")


def test_an_explicit_id_overrides_the_configured_one(client, monkeypatch):
    monkeypatch.setattr(qr_router, "SAVINGS_PROMPTPAY_ID", CONFIGURED_ID)

    body = client.post(
        "/qr/", json={"amount_thb": 250, "promptpay_id": "1234567890123"}
    ).json()

    assert body["payload"] == build_promptpay_payload("1234567890123", 250)


class TestRejectedRequests:
    def test_no_configured_id_and_none_supplied(self, client, monkeypatch):
        # There is deliberately no mock mode here -- a QR pointing at the
        # wrong account would move real money, so it must fail loudly.
        monkeypatch.setattr(qr_router, "SAVINGS_PROMPTPAY_ID", "")

        response = client.post("/qr/", json={"amount_thb": 250})

        assert response.status_code == 400
        assert "SAVINGS_PROMPTPAY_ID" in response.json()["detail"]

    def test_zero_amount(self, client, monkeypatch):
        monkeypatch.setattr(qr_router, "SAVINGS_PROMPTPAY_ID", CONFIGURED_ID)
        assert client.post("/qr/", json={"amount_thb": 0}).status_code == 400

    def test_negative_amount(self, client, monkeypatch):
        monkeypatch.setattr(qr_router, "SAVINGS_PROMPTPAY_ID", CONFIGURED_ID)
        assert client.post("/qr/", json={"amount_thb": -50}).status_code == 400

    def test_missing_amount(self, client):
        assert client.post("/qr/", json={}).status_code == 422
