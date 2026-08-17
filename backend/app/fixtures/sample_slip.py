"""Typed-out mock transfer slip, used by OCR_MOCK_MODE for the slip-scan
path since no real slip photos exist yet.

A transfer slip carries no line items -- only who was paid, when, and how
much -- so this is shaped like the {payee, purchased_at, amount,
transaction_id} schema the slip prompt asks for, not the receipt one.
"""

SAMPLE_SLIP = {
    "payee": "ร้านทดสอบ (สาขาทดสอบ)",
    "purchased_at": "2026-08-17",
    "amount": 55.0,
    "transaction_id": "0000000000TEST0000",
}
