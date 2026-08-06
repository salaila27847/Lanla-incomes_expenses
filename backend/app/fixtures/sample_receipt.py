"""Typed-out mock receipt, used by OCR_MOCK_MODE since no real receipt
photos exist yet. Modeled loosely on a 7-Eleven receipt: mixed food and
household items, Thai item names as they'd actually print (abbreviated,
inconsistent spacing) so /match has something realistic to fuzzy-match
against a master item list.

Written in the shape the structuring model is asked for -- `line_total`
and `quantity`, both as printed -- so mock mode exercises the same
normalisation as a real scan. Two lines buy more than one unit, including
one whose total doesn't divide evenly, which is the case where recording
the line as the item's price goes most obviously wrong.
"""

SAMPLE_RECEIPT = {
    "store": "7-Eleven สาขาทดสอบ",
    "purchased_at": "2026-08-04",
    "items": [
        {"id": "1", "raw_text": "นมสดUHT250ml", "quantity": 3, "line_total": 45.0},
        {"id": "2", "raw_text": "ขนมปังแซนวิชแฮม", "quantity": 1, "line_total": 29.0},
        {"id": "3", "raw_text": "น้ำดื่มสิงห์600ml", "quantity": 6, "line_total": 41.0},
        {"id": "4", "raw_text": "ไข่ไก่เบอร์0แผง10ฟอง", "quantity": 1, "line_total": 45.0},
        {"id": "5", "raw_text": "กระดาษทิชชู่ม้วน", "quantity": 1, "line_total": 22.0},
        {"id": "6", "raw_text": "สบู่เหลวลอรีอัล", "quantity": 1, "line_total": 59.0},
        {"id": "7", "raw_text": "มาม่าต้มยำกุ้ง", "quantity": 1, "line_total": 6.0},
    ],
}
