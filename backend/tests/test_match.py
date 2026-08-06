"""Fuzzy master-item matching.

The point of the confidence threshold is that a wrong-but-confident match
silently mis-tags a receipt line, which is worse than asking the user.

Two thresholds now: one for "worth showing", one for "safe to pick without
asking". The scores below are measured, not invented -- the gap between
them is exactly the band where a receipt is genuinely ambiguous.
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
    assert response.json() == {
        "matched": False,
        "master_item_name": None,
        "score": 0,
        "candidates": [],
    }


class TestConfidenceThreshold:
    def test_below_threshold_withholds_the_name(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 99)

        body = post_match(client, "นมสด", ["ขนมปังแซนวิชแฮม"]).json()

        assert body["matched"] is False
        assert body["master_item_name"] is None

    def test_the_floor_also_blocks_auto_apply(self, client, monkeypatch):
        # A perfect score still can't be applied if the floor is above it:
        # the floor gates the candidate list, and an empty list means there
        # is nothing to apply. (Score reporting and the auto-apply boundary
        # are covered in TestCandidateList and TestAutoApplyThreshold.)
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 101)

        body = post_match(client, "ขนมปัง", ["ขนมปัง"]).json()

        assert body["score"] == 100
        assert body["matched"] is False


def test_picks_the_best_of_several_candidates(client):
    body = post_match(
        client, "มาม่าต้มยำกุ้ง", ["ขนมปังแซนวิชแฮม", "มาม่าต้มยำกุ้ง", "น้ำดื่มสิงห์600ml"]
    ).json()

    assert body["master_item_name"] == "มาม่าต้มยำกุ้ง"


def test_rejects_a_malformed_request(client):
    assert client.post("/match/", json={"raw_text": "นมสด"}).status_code == 422


class TestCandidateList:
    """Everything above the confidence floor comes back, best first, so the
    picker has alternatives to offer rather than one take-it-or-leave-it
    answer."""

    def test_returns_candidates_ranked_best_first(self, client):
        body = post_match(
            client, "นมสด UHT 250ml", ["ขนมปังแซนวิชแฮม", "นมสด UHT 250ml", "นมสด UHT 200ml"]
        ).json()

        names = [candidate["name"] for candidate in body["candidates"]]
        assert names[0] == "นมสด UHT 250ml"
        assert "ขนมปังแซนวิชแฮม" not in names  # nowhere near the floor
        assert body["candidates"][0]["score"] >= body["candidates"][-1]["score"]

    def test_omits_candidates_below_the_confidence_floor(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 99)

        body = post_match(client, "นมสดUHT250ml", ["นมสด UHT 250ml"]).json()

        assert body["candidates"] == []

    def test_caps_how_many_are_returned(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_CANDIDATE_LIMIT", 2)
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 0)

        body = post_match(client, "นมสด", ["นมสด A", "นมสด B", "นมสด C", "นมสด D"]).json()

        assert len(body["candidates"]) == 2

    def test_reports_the_best_score_even_with_no_qualifying_candidate(self, client, monkeypatch):
        # The score is what lets the frontend explain itself; zeroing it
        # along with the list would leave the UI with nothing to show.
        monkeypatch.setattr(match_router, "MATCH_CONFIDENCE_THRESHOLD", 101)

        body = post_match(client, "นมสดUHT250ml", ["นมสด UHT 250ml"]).json()

        assert body["candidates"] == []
        assert body["score"] > 0


class TestAutoApplyThreshold:
    """The band between the thresholds is the whole point: offered, not
    chosen."""

    def test_spacing_noise_is_confident_enough_to_apply(self, client):
        # 92: the master list spaces the name, the receipt doesn't. Same
        # product, and making the user tap for this would be noise.
        body = post_match(client, "นมสดUHT250ml", ["นมสด UHT 250ml"]).json()

        assert body["matched"] is True
        assert body["master_item_name"] == "นมสด UHT 250ml"

    def test_a_receipt_without_the_brand_is_offered_but_not_chosen(self, client):
        # The case that matters. "นมสด250ml" scores 64 against both brands
        # -- identically, because the receipt never says which one it was.
        # Picking either would silently merge two products' price histories.
        body = post_match(
            client, "นมสด250ml", ["นมสด โฟร์โมสต์ 250ml", "นมสด ดัชมิลล์ 250ml"]
        ).json()

        assert body["matched"] is False
        assert body["master_item_name"] is None
        assert len(body["candidates"]) == 2  # both offered, neither assumed

    def test_neither_brand_wins_on_score(self, client):
        # If one scored higher the tie-break would be arbitrary but stable;
        # they don't, which is why this can't be solved by tuning.
        body = post_match(
            client, "นมสด250ml", ["นมสด โฟร์โมสต์ 250ml", "นมสด ดัชมิลล์ 250ml"]
        ).json()

        assert body["candidates"][0]["score"] == body["candidates"][1]["score"]

    def test_at_the_threshold_counts_as_confident(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_AUTO_APPLY_THRESHOLD", 100)

        body = post_match(client, "ขนมปัง", ["ขนมปัง"]).json()

        assert body["score"] == 100
        assert body["matched"] is True

    def test_just_under_the_threshold_does_not(self, client, monkeypatch):
        monkeypatch.setattr(match_router, "MATCH_AUTO_APPLY_THRESHOLD", 101)

        body = post_match(client, "ขนมปัง", ["ขนมปัง"]).json()

        assert body["matched"] is False
        assert body["candidates"][0]["name"] == "ขนมปัง"  # still suggested
