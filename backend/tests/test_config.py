"""Environment parsing.

Every value here comes from a hosting dashboard rather than a file, and
pasting into one can pick up stray whitespace: a leading tab on
TYPHOON_BASE_URL took the deployed API down with an opaque
`httpx.InvalidURL` on every scan, and looked completely correct in the
dashboard UI. Stripping is the fix, so it needs to stay tested.
"""

import importlib

import pytest

import app.config


@pytest.fixture
def load_config(monkeypatch):
    """Re-import app.config with the given environment applied."""

    def _load(**env):
        for name in (
            "TYPHOON_API_KEY",
            "TYPHOON_BASE_URL",
            "TYPHOON_OCR_MODEL",
            "TYPHOON_TEXT_MODEL",
            "OCR_MOCK_MODE",
            "MATCH_CONFIDENCE_THRESHOLD",
            "SAVINGS_PROMPTPAY_ID",
        ):
            monkeypatch.delenv(name, raising=False)
        for name, value in env.items():
            monkeypatch.setenv(name, value)
        return importlib.reload(app.config)

    yield _load
    importlib.reload(app.config)  # leave the module as the rest of the suite found it


class TestWhitespaceStripping:
    def test_strips_a_leading_tab_from_the_base_url(self, load_config):
        # The exact production failure.
        config = load_config(TYPHOON_BASE_URL="\thttps://api.opentyphoon.ai/v1")
        assert config.TYPHOON_BASE_URL == "https://api.opentyphoon.ai/v1"

    def test_strips_surrounding_whitespace_and_newlines(self, load_config):
        config = load_config(TYPHOON_BASE_URL="  https://example.test/v1 \n")
        assert config.TYPHOON_BASE_URL == "https://example.test/v1"

    def test_strips_the_api_key(self, load_config):
        # A key with a trailing newline authenticates as garbage.
        config = load_config(TYPHOON_API_KEY=" sk-abc123\n")
        assert config.TYPHOON_API_KEY == "sk-abc123"

    def test_strips_model_names(self, load_config):
        config = load_config(TYPHOON_OCR_MODEL="\ttyphoon-ocr ")
        assert config.TYPHOON_OCR_MODEL == "typhoon-ocr"

    def test_strips_the_promptpay_id(self, load_config):
        config = load_config(SAVINGS_PROMPTPAY_ID=" 0899999999 ")
        assert config.SAVINGS_PROMPTPAY_ID == "0899999999"

    def test_a_padded_threshold_still_parses(self, load_config):
        # int() tolerates surrounding whitespace on its own, so stripping
        # is belt-and-braces here -- this pins the behaviour, not the strip.
        config = load_config(MATCH_CONFIDENCE_THRESHOLD="\t75\n")
        assert config.MATCH_CONFIDENCE_THRESHOLD == 75


class TestBlankValues:
    """A variable created in a dashboard but left blank is not a value.

    `os.environ.get(name, default)` returns "" for those rather than the
    default, so a blank MATCH_CONFIDENCE_THRESHOLD used to raise
    ValueError at import time and take down every endpoint, not just
    matching.
    """

    def test_a_blank_threshold_falls_back_instead_of_crashing_at_import(self, load_config):
        assert load_config(MATCH_CONFIDENCE_THRESHOLD="").MATCH_CONFIDENCE_THRESHOLD == 60

    def test_a_blank_mock_mode_flag_stays_safe(self, load_config):
        # Blank must not read as "not true" and silently start calling a
        # paid API with an empty key.
        assert load_config(OCR_MOCK_MODE="").OCR_MOCK_MODE is True

    def test_a_blank_base_url_falls_back_to_the_real_api(self, load_config):
        # "" would make every request go to a relative, unusable URL.
        assert load_config(TYPHOON_BASE_URL="").TYPHOON_BASE_URL == "https://api.opentyphoon.ai/v1"

    def test_a_whitespace_only_value_counts_as_blank(self, load_config):
        assert load_config(TYPHOON_OCR_MODEL="   ").TYPHOON_OCR_MODEL == "typhoon-ocr"

    def test_an_explicit_false_still_disables_mock_mode(self, load_config):
        # The fallback must not make it impossible to turn mock mode off.
        assert load_config(OCR_MOCK_MODE="false").OCR_MOCK_MODE is False


class TestDefaults:
    def test_ocr_defaults_to_mock_mode(self, load_config):
        # Safe by default: without a key, scanning must still work.
        assert load_config().OCR_MOCK_MODE is True

    def test_unset_secrets_default_to_empty_not_none(self, load_config):
        config = load_config()
        assert config.TYPHOON_API_KEY == ""
        assert config.SAVINGS_PROMPTPAY_ID == ""

    def test_model_and_url_defaults(self, load_config):
        config = load_config()
        assert config.TYPHOON_BASE_URL == "https://api.opentyphoon.ai/v1"
        assert config.TYPHOON_OCR_MODEL == "typhoon-ocr"
        # Only the OCR model is reachable via the dedicated /ocr endpoint;
        # structuring needs a separate instruct model.
        assert config.TYPHOON_TEXT_MODEL != config.TYPHOON_OCR_MODEL


class TestMockModeFlag:
    @pytest.mark.parametrize("value", ["false", "False", "FALSE"])
    def test_disabled_case_insensitively(self, load_config, value):
        assert load_config(OCR_MOCK_MODE=value).OCR_MOCK_MODE is False

    @pytest.mark.parametrize("value", ["true", "TRUE", "True"])
    def test_enabled_case_insensitively(self, load_config, value):
        assert load_config(OCR_MOCK_MODE=value).OCR_MOCK_MODE is True

    def test_padded_true_still_enables(self, load_config):
        # The hazardous direction: unstripped, " true\n" != "true", so an
        # operator who set it to true would silently get the real API --
        # a padded "false" is harmless by comparison, since it reads as
        # false either way.
        assert load_config(OCR_MOCK_MODE=" true\n").OCR_MOCK_MODE is True
