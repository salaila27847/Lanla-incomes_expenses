"""Typed-out mock receipt, used by OCR_MOCK_MODE since no real receipt
photos exist yet. Modeled loosely on a 7-Eleven receipt: mixed food and
household items, Thai item names as they'd actually print (abbreviated,
inconsistent spacing) so /match has something realistic to fuzzy-match
against a master item list.
"""

SAMPLE_RECEIPT = {
    "store": "7-Eleven สาขาทดสอบ",
    "purchased_at": "2026-08-04",
    "items": [
        {"id": "1", "raw_text": "นมสดUHT250ml", "price": 15.0},
        {"id": "2", "raw_text": "ขนมปังแซนวิชแฮม", "price": 29.0},
        {"id": "3", "raw_text": "น้ำดื่มสิงห์600ml", "price": 7.0},
        {"id": "4", "raw_text": "ไข่ไก่เบอร์0แผง10ฟอง", "price": 45.0},
        {"id": "5", "raw_text": "กระดาษทิชชู่ม้วน", "price": 22.0},
        {"id": "6", "raw_text": "สบู่เหลวลอรีอัล", "price": 59.0},
        {"id": "7", "raw_text": "มาม่าต้มยำกุ้ง", "price": 6.0},
    ],
}
