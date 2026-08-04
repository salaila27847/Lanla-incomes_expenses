"""PromptPay QR payload builder (EMVCo Merchant-Presented Mode).

Field order and formatting match the reference implementation at
github.com/dtinth/promptpay-qr (the library behind promptpay2.me).
Verified against that library's own test vectors (phone number,
national ID, tax ID, e-wallet ID, and a dynamic-amount case) before
this was wired into a real endpoint.
"""

import re

_GUID_PROMPTPAY = "A000000677010111"
_COUNTRY_CODE_TH = "TH"
_CURRENCY_THB = "764"


def _field(tag: str, value: str) -> str:
    return f"{tag}{len(value):02d}{value}"


def _sanitize_target(target: str) -> str:
    return re.sub(r"[^0-9]", "", target)


def _format_target(digits: str) -> str:
    if len(digits) >= 13:
        return digits
    replaced = re.sub(r"^0", "66", digits, count=1)
    return replaced.rjust(13, "0")


def _crc16_ccitt_false(data: str) -> str:
    crc = 0xFFFF
    for byte in data.encode("ascii"):
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return f"{crc:04X}"


def build_promptpay_payload(target: str, amount: float) -> str:
    """target: a phone number, national/tax ID, or e-wallet ID (any
    punctuation is stripped). amount: THB, > 0 — this always builds a
    dynamic (fixed-amount) QR, since that's the only case this app needs.
    """
    digits = _sanitize_target(target)
    target_type = "03" if len(digits) >= 15 else "02" if len(digits) >= 13 else "01"

    merchant_info = _field("00", _GUID_PROMPTPAY) + _field(target_type, _format_target(digits))

    fields = [
        _field("00", "01"),
        _field("01", "12"),
        _field("29", merchant_info),
        _field("58", _COUNTRY_CODE_TH),
        _field("53", _CURRENCY_THB),
        _field("54", f"{amount:.2f}"),
    ]

    payload_without_crc = "".join(fields)
    to_crc = payload_without_crc + "6304"
    checksum = _crc16_ccitt_false(to_crc)
    return payload_without_crc + _field("63", checksum)
