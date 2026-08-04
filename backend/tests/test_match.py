"""Fuzzy master-item matching.

The point of the confidence threshold is that a wrong-but-confident match
silently mis-tags a receipt line, which is worse than asking the user.
"""

from app.routers import match as match_router


def post_match(client, raw_text, candidates):
    return client.post(
        "/match/", json={"raw_text": raw_text, "candidate_master_items": candidates}
    )


def test_exact_name_matches(client):
    body = post_match(client, "นมสด UHT 250ml", ["นมสด UHT 250ml", "ขนมปัง"]).json()

    assert body["matched"] is True
    assert body["master_item_name"] == "นมสด UHT 250ml"
    assert body["score"] == 100


def test_ocr_spacing_noise_still_matches(client):
    # Receipts print names unspaced; the master list has them spaced.
    body = post_match(client, "นมสดUHT250ml", ["นมสด UHT 250ml", "มาม่าต้มยำกุ้ง"]).json()

    assert body["matched"] is True
    assert body["master_item_name"] == "นมสด UHT 250ml"


def test_empty_candidate_list_is_a_normal_no_match(client):
    # A brand-new install has no master items yet -- this used to error
    # instead of simply reporting "no match".
    response = post_match(client, "นมสด", [])

    assert response.status_code == 200
    assert response.json() == {"matched": False, "master_item_name": None, "score": 0}


class TestConfidenceThreshold:
    def test_below_threshold_withholds_the_name(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 99)

        body = post_match(client, "นมสด", ["ขนมปังแซนวิชแฮม"]).json()

        assert body["matched"] is False
        assert body["master_item_name"] is None

    def test_reports_the_score_even_when_withholding_the_name(self, client, monkeypatch):
        # The score is what lets the frontend explain itself; dropping it
        # along with the name would leave the UI with nothing to show.
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 101)

        body = post_match(client, "นมสด UHT", ["นมสด UHT 250ml"]).json()

        assert body["matched"] is False
        assert body["score"] > 0

    def test_a_score_exactly_at_the_threshold_counts_as_a_match(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 100)

        body = post_match(client, "ขนมปัง", ["ขนมปัง"]).json()

        assert body["score"] == 100
        assert body["matched"] is True


def test_picks_the_best_of_several_candidates(client):
    body = post_match(
        client, "มาม่าต้มยำกุ้ง", ["ขนมปังแซนวิชแฮม", "มาม่าต้มยำกุ้ง", "น้ำดื่มสิงห์600ml"]
    ).json()

    assert body["master_item_name"] == "มาม่าต้มยำกุ้ง"


def test_rejects_a_malformed_request(client):
    assert client.post("/match/", json={"raw_text": "นมสด"}).status_code == 422
