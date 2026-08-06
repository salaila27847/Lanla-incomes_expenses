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
        body = response.json()
        assert body["store"] == SAMPLE_RECEIPT["store"]
        assert body["purchased_at"] == SAMPLE_RECEIPT["purchased_at"]
        assert len(body["items"]) == len(SAMPLE_RECEIPT["items"])

    def test_normalises_the_fixture_like_a_real_scan(self, client, receipt_upload):
        # Mock mode is what the app runs on without an API key, so it has to
        # go through the same unit-price arithmetic -- otherwise the one
        # path that's always exercised is the one that's never tested.
        items = {item["raw_text"]: item for item in client.post("/ocr/", files=receipt_upload).json()["items"]}

        assert items["นมสดUHT250ml"] == {
            "id": "1",
            "raw_text": "นมสดUHT250ml",
            "quantity": 3,
            "price": 15.0,  # 45.00 for three, before the discount
            "discount": 5.0,
        }

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
                    "items": [
                        {"id": "1", "raw_text": "ขนมปัง", "quantity": 1, "line_total": 29.0}
                    ],
                }
            ),
        )

        response = client.post("/ocr/", files=receipt_upload)

        assert response.status_code == 200
        assert response.json() == {
            "store": "Lotus",
            "purchased_at": "2026-08-04",
            "items": [
                {"id": "1", "raw_text": "ขนมปัง", "quantity": 1, "price": 29.0, "discount": 0.0}
            ],
            "bill_discount": 0.0,
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


class TestQuantity:
    """A line that bought several units.

    Recording its line total as the item's price is wrong twice over: the
    budget is only right by accident, and the price history -- the whole
    point of the app -- records 45 THB as the price of a 15 THB carton.

    The division happens here rather than in the prompt because a model
    that gets it wrong produces a plausible number, and a plausible wrong
    price is invisible.
    """

    def scan(self, client, typhoon, receipt_upload, item):
        typhoon.chat = httpx.Response(
            200,
            json=FakeTyphoon.chat_body(
                {"store": "Lotus", "purchased_at": "2026-08-04", "items": [item]}
            ),
        )
        return client.post("/ocr/", files=receipt_upload).json()["items"][0]

    def test_divides_the_line_total_by_the_quantity(self, client, typhoon, receipt_upload):
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 3, "line_total": 45.0},
        )

        assert item["price"] == 15.0
        assert item["quantity"] == 3

    def test_rounds_a_total_that_does_not_divide_evenly(self, client, typhoon, receipt_upload):
        # 6 bottles for 41 THB. Two decimals, so quantity x price is within
        # a satang of the receipt rather than carrying a long fraction.
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "น้ำดื่ม", "quantity": 6, "line_total": 41.0},
        )

        assert item["price"] == 6.83

    def test_a_missing_quantity_means_one(self, client, typhoon, receipt_upload):
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "ขนมปัง", "line_total": 29.0},
        )

        assert item["quantity"] == 1
        assert item["price"] == 29.0

    def test_a_zero_quantity_means_one(self, client, typhoon, receipt_upload):
        # Guards the division, and zero is not a thing you can buy.
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "ขนมปัง", "quantity": 0, "line_total": 29.0},
        )

        assert item["quantity"] == 1
        assert item["price"] == 29.0

    def test_a_negative_quantity_means_one(self, client, typhoon, receipt_upload):
        # Zero is already handled by `or 1` being falsy; a negative is what
        # the clamp is actually for. Unclamped it flips the price negative
        # and the line starts subtracting from the budget.
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "ขนมปัง", "quantity": -2, "line_total": 29.0},
        )

        assert item["quantity"] == 1
        assert item["price"] == 29.0

    def test_a_nonsense_quantity_means_one(self, client, typhoon, receipt_upload):
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "ขนมปัง", "quantity": "หลายชิ้น", "line_total": 29.0},
        )

        assert item["quantity"] == 1

    def test_a_decimal_quantity_is_truncated(self, client, typhoon, receipt_upload):
        # Weighed goods print "1.5 kg"; the app counts units, not weight.
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "หมูสับ", "quantity": 2.9, "line_total": 100.0},
        )

        assert item["quantity"] == 2

    def test_falls_back_to_price_when_the_model_ignores_the_new_schema(
        self, client, typhoon, receipt_upload
    ):
        # The old prompt's field name. A model that answers in the old shape
        # must still produce a usable line rather than a zero.
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "ขนมปัง", "price": 29.0},
        )

        assert item == {
            "id": "1",
            "raw_text": "ขนมปัง",
            "quantity": 1,
            "price": 29.0,
            "discount": 0.0,
        }

    def test_an_unparsable_total_becomes_zero_rather_than_crashing(
        self, client, typhoon, receipt_upload
    ):
        # One bad line shouldn't cost the user the whole scan.
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "อ่านไม่ออก", "quantity": 1, "line_total": "??"},
        )

        assert item["price"] == 0

    def test_numbers_arriving_as_strings_still_parse(self, client, typhoon, receipt_upload):
        item = self.scan(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": "3", "line_total": "45.00"},
        )

        assert item == {
            "id": "1",
            "raw_text": "นมสด",
            "quantity": 3,
            "price": 15.0,
            "discount": 0.0,
        }

    def test_fills_in_a_missing_id_from_the_line_order(self, client, typhoon, receipt_upload):
        typhoon.chat = httpx.Response(
            200,
            json=FakeTyphoon.chat_body(
                {
                    "store": None,
                    "purchased_at": None,
                    "items": [
                        {"raw_text": "หนึ่ง", "quantity": 1, "line_total": 1.0},
                        {"raw_text": "สอง", "quantity": 1, "line_total": 2.0},
                    ],
                }
            ),
        )

        items = client.post("/ocr/", files=receipt_upload).json()["items"]

        assert [item["id"] for item in items] == ["1", "2"]

    def test_a_response_with_no_items_is_an_empty_list_not_a_crash(
        self, client, typhoon, receipt_upload
    ):
        typhoon.chat = httpx.Response(
            200, json=FakeTyphoon.chat_body({"store": "Lotus", "purchased_at": None})
        )

        body = client.post("/ocr/", files=receipt_upload).json()

        assert body["items"] == []


class TestDiscounts:
    """Receipts discount lines individually and the bill as a whole.

    Both are kept out of the unit price on purpose: the price history's job
    is what a product normally costs, and a promo that won't be there next
    time shouldn't become that. What was paid is price * quantity - discount.
    """

    def scan(self, client, typhoon, receipt_upload, parsed):
        typhoon.chat = httpx.Response(200, json=FakeTyphoon.chat_body(parsed))
        return client.post("/ocr/", files=receipt_upload).json()

    def one_item(self, client, typhoon, receipt_upload, item, **extra):
        body = self.scan(
            client, typhoon, receipt_upload,
            {"store": "Lotus", "purchased_at": None, "items": [item], **extra},
        )
        return body["items"][0], body

    def test_keeps_the_printed_price_and_reports_the_discount_beside_it(
        self, client, typhoon, receipt_upload
    ):
        item, _ = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 3, "line_total": 45.0, "discount": 5.0},
        )

        # Not 13.33: folding the discount into the unit price is what would
        # make the price history remember a promo as the product's price.
        assert item["price"] == 15.0
        assert item["discount"] == 5.0

    def test_strips_the_sign_a_receipt_prints(self, client, typhoon, receipt_upload):
        # Receipts show discounts as negatives and the model copies that
        # about half the time. A negative discount would *add* to the bill.
        item, _ = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0, "discount": -5.0},
        )

        assert item["discount"] == 5.0

    def test_no_discount_is_zero_not_missing(self, client, typhoon, receipt_upload):
        item, _ = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0},
        )

        assert item["discount"] == 0.0

    def test_an_unreadable_discount_is_no_discount(self, client, typhoon, receipt_upload):
        # Safe direction: leave the line at its printed price rather than
        # invent a saving the receipt doesn't support.
        item, _ = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0, "discount": "ลด"},
        )

        assert item["discount"] == 0.0

    def test_reports_a_bill_level_discount(self, client, typhoon, receipt_upload):
        _, body = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0},
            bill_discount=20.0,
        )

        assert body["bill_discount"] == 20.0

    def test_a_bill_discount_is_not_folded_into_any_line(self, client, typhoon, receipt_upload):
        # It belongs to no single product, so spreading it across lines
        # would corrupt every unit price on the receipt.
        item, body = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0},
            bill_discount=20.0,
        )

        assert item["price"] == 15.0
        assert item["discount"] == 0.0
        assert body["bill_discount"] == 20.0

    def test_a_missing_bill_discount_is_zero(self, client, typhoon, receipt_upload):
        _, body = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0},
        )

        assert body["bill_discount"] == 0.0

    def test_strips_the_sign_on_a_bill_discount_too(self, client, typhoon, receipt_upload):
        _, body = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0},
            bill_discount=-20.0,
        )

        assert body["bill_discount"] == 20.0

    def test_a_discount_string_with_a_currency_sign_is_ignored_not_guessed(
        self, client, typhoon, receipt_upload
    ):
        item, _ = self.one_item(
            client, typhoon, receipt_upload,
            {"id": "1", "raw_text": "นมสด", "quantity": 1, "line_total": 15.0, "discount": "5 บาท"},
        )

        assert item["discount"] == 0.0

    def test_the_prompt_tells_the_model_not_to_list_discounts_as_items(
        self, client, typhoon, receipt_upload
    ):
        # Without this a "ส่วนลด -20.00" line comes back as a product, and
        # the user has to name and categorise a discount as if it were food.
        client.post("/ocr/", files=receipt_upload)

        prompt = json.loads(typhoon.request_to("/chat/completions").content)["messages"][0][
            "content"
        ]
        assert "bill_discount" in prompt
        assert "never list a discount" in prompt
