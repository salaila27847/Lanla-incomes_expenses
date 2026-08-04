"""PromptPay EMVCo payload tests.

Two independent anchors keep these from merely asserting whatever our own
code happens to produce:

1. A published payload from the reference implementation
   (github.com/dtinth/promptpay-qr, the library behind promptpay2.me).
2. The universal CRC-16/CCITT-FALSE check value: "123456789" -> 0x29B1.

Everything else checks structure that follows from the EMVCo spec.
"""

from app.promptpay import _crc16_ccitt_false, build_promptpay_payload

# 089-999-9999, amount 420 THB, from the reference implementation.
REFERENCE_TARGET = "089-999-9999"
REFERENCE_AMOUNT = 420
REFERENCE_PAYLOAD = (
    "00020101021229370016A000000677010111011300668999999995802TH53037645406420.006304CF9E"
)


def parse_fields(payload: str) -> dict[str, str]:
    """Split an EMVCo payload into {tag: value} (top level only)."""
    fields, cursor = {}, 0
    while cursor < len(payload):
        tag = payload[cursor : cursor + 2]
        length = int(payload[cursor + 2 : cursor + 4])
        fields[tag] = payload[cursor + 4 : cursor + 4 + length]
        cursor += 4 + length
    return fields


def test_matches_reference_implementation_payload():
    assert build_promptpay_payload(REFERENCE_TARGET, REFERENCE_AMOUNT) == REFERENCE_PAYLOAD


def test_crc16_matches_the_standard_check_value():
    # The documented check value for CRC-16/CCITT-FALSE across every
    # implementation of the algorithm -- catches a subtly wrong polynomial
    # or init value, which a self-consistent round-trip test would not.
    assert _crc16_ccitt_false("123456789") == "29B1"


def test_punctuation_in_the_target_is_ignored():
    assert build_promptpay_payload("089-999-9999", 420) == build_promptpay_payload("0899999999", 420)


class TestTargetTypeTag:
    """Tag 01/02/03 inside the merchant field selects phone / ID / e-wallet."""

    @staticmethod
    def merchant_value(payload: str) -> str:
        return parse_fields(payload)["29"]

    def test_ten_digit_phone_uses_tag_01_and_is_normalised(self):
        merchant = self.merchant_value(build_promptpay_payload("0899999999", 1))
        # Leading 0 becomes the 66 country code, zero-padded to 13 digits.
        assert merchant == "0016A00000067701011101130066899999999"

    def test_thirteen_digit_national_id_uses_tag_02(self):
        merchant = self.merchant_value(build_promptpay_payload("1234567890123", 1))
        assert merchant == "0016A00000067701011102131234567890123"

    def test_fifteen_digit_ewallet_uses_tag_03(self):
        merchant = self.merchant_value(build_promptpay_payload("123456789012345", 1))
        assert merchant == "0016A0000006770101110315123456789012345"


class TestPayloadStructure:
    def test_amount_is_always_two_decimal_places(self):
        assert parse_fields(build_promptpay_payload("0899999999", 4.2))["54"] == "4.20"
        assert parse_fields(build_promptpay_payload("0899999999", 100))["54"] == "100.00"

    def test_declares_thailand_and_thai_baht(self):
        fields = parse_fields(build_promptpay_payload("0899999999", 1))
        assert fields["58"] == "TH"
        assert fields["53"] == "764"

    def test_uses_the_dynamic_qr_initiation_method(self):
        # 01 = static (reusable), 12 = dynamic (one amount). This app only
        # ever builds fixed-amount QRs, so it must be 12.
        assert parse_fields(build_promptpay_payload("0899999999", 1))["01"] == "12"

    def test_checksum_is_the_final_field_and_covers_everything_before_it(self):
        payload = build_promptpay_payload("0899999999", 55.5)
        body, checksum = payload[:-4], payload[-4:]
        assert body.endswith("6304")
        assert _crc16_ccitt_false(body) == checksum

    def test_a_tampered_payload_fails_its_own_checksum(self):
        # Swapping the amount for one of equal length keeps every length
        # prefix valid, so only the checksum can catch it.
        payload = build_promptpay_payload("0899999999", 55.5)
        tampered = payload.replace("55.50", "99.50")
        assert tampered != payload  # guard: the substitution actually applied
        assert _crc16_ccitt_false(tampered[:-4]) != tampered[-4:]
