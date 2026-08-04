# 📄 System Specification: Smart Expense & Price Tracker

> **Implementation notes (added during scaffolding, not part of the original spec):**
> The spec below leaves the OCR/matching/QR libraries and the controller's exact runtime open. The scaffold in this repo makes these concrete choices:
> - **Backend (OCR / fuzzy matching / QR generation):** Python + FastAPI on Vercel, as specified. OCR uses [Typhoon OCR](https://opentyphoon.ai/) (SCB 10X) via its OpenAI-compatible chat-completions API — free (research showcase, beta/rate-limited but fine for personal use), Thai-optimized, and avoids the GCP billing-account setup Google Cloud Vision would need. (An earlier draft of this scaffold picked Vision API; switched once Typhoon's free tier was confirmed.) A custom prompt asks Typhoon to return structured JSON line items directly, rather than using the official `typhoon-ocr` pip package, which additionally requires the `poppler-utils` system binary — not installable on Vercel's Python serverless runtime — and returns generic markdown that would still need line-item parsing. Fuzzy matching uses `rapidfuzz`, implemented for real (see `backend/app/routers/match.py`), with a confidence threshold below which the API reports no match rather than guessing. QR generation builds the PromptPay EMVCo payload and renders it with the `qrcode` package — still stubbed.
> - **Controller:** the spec below describes this layer as Google Apps Script + Google Sheets. Per explicit direction, this scaffold replaces Apps Script with a **Node.js/Express** service that talks to Google Sheets directly via the Sheets API (`googleapis`, service-account credentials) instead of `SpreadsheetApp`/`doPost`. Google Sheets remains the database. This is the one deviation from the spec below — everything else matches as written.
> - **Frontend:** the spec below lists "Vue.js / React" as options; **React** was chosen.
>
> See `CLAUDE.md` for the resulting repo layout and how to run each service.

ระบบบันทึกรายรับ-รายจ่ายและเปรียบเทียบราคาสินค้าอัตโนมัติ เน้นการสแกนสลิปผ่าน Web App ที่แม่นยำ แยกหมวดหมู่สินค้าในสลิปเดียว และคำนวณงบประมาณได้อย่างรวดเร็ว

---

## 💡 Core Features & Business Logic

### 1. Split-Bill OCR & Master Item Matching (สแกนแยกบรรทัด + ชื่อสินค้ามาตรฐาน)
- **Split Category:** สแกนสลิปยาว 1 ใบ แยกรายการ [ของกิน] และ [ของใช้] ออกจากกันโดยอัตโนมัติ
- **Master Item Standardization:** ใช้ Fuzzy Matching แปลงชื่อสินค้าจากสลิปที่พิมพ์ไม่เหมือนกัน ให้เข้าสู่ "ชื่อสินค้ามาตรฐาน (Unique Name)" ในระบบเพื่อใช้แทร็กราคา
- **Interactive Review UI:** แสดงผลตารางพรีวิวบน PWA หน้าจอเดียว:
  - ปุ่ม Toggle สลับ [🍔 กิน] / [🧴 ใช้] แยกตามรายการ
  - Search Dropdown Auto-complete เลือก/เปลี่ยนชื่อ Master Item ได้ใน 1-Tap

### 2. Budget & Expense Management (จัดการงบประมาณเป๊ะๆ)
- **Daily Budget Separation:** ตัดงบ ค่ากิน (5,000 บาท) และ ของใช้ (5,000 บาท) แยกจากกันทันที เพื่อไม่ให้งบประมาณบิดเบือน
- **Must to Pay Checklist:** ระบบสร้างรายการจ่ายประจำเดือนรอไว้ สแกนสลิปจ่ายแล้วเปลี่ยนสถานะเป็น 🟢 จ่ายแล้ว อัตโนมัติ

### 3. Price History Lookup (ค้นหาประวัติราคาตามแหล่งซื้อ)
- **Price Tracking:** บันทึกข้อมูล 3 มิติ (ราคา + วันที่ + ร้านค้า/สถานที่)
- **Query via PWA:** พิมพ์ค้นหาประวัติราคาสินค้าในหน้า Search ของ PWA
- **Result Display:** แสดง Timeline ประวัติราคาที่เคยซื้อ เรียงตามสถานที่ (7-Eleven / ตลาดสด / Lotus's) เพื่อใช้วางแผนการซื้อครั้งถัดไป

### 4. Savings Protection (ระบบป้องกันเงินออมด้วย Dynamic QR Code)
- กรณีเลือกชำระเงินด้วย "บัญชีเงินออม"
- PWA จะ Pop-up แสดง Dynamic PromptPay QR Code ตามยอดเงินเป๊ะๆ ขึ้นบนหน้าจอทันที เพื่อให้สแกนโอนเงินคืนจากบัญชีหลักเข้าบัญชีออมได้ทันที

---

## 🛠️ Tech Stack & Architecture (Phase 1: Web App)

- **Frontend:** PWA (Progressive Web App) เขียนด้วย Vue.js / React + Tailwind CSS (รองรับการ Add to Home Screen บนมือถือ)
- **Database & Controller:** Google Apps Script (GAS) + Google Sheets
- **Backend & AI Processor:** Python (FastAPI) Hosted on **Vercel** (Free, No Cold Start, Fast Latency)
- **OCR & Matching Engine:** Python-based Line-Item OCR + Fuzzy Text Matching Algorithm

---

## 🏗️ Data Flow & System Diagram

```text
[📱 PWA Web App (Frontend)]
      │ (1. ถ่ายรูปสลิป / คีย์ข้อมูล / พิมพ์ค้นราคา)
      ▼
[⚡ Google Apps Script (Proxy/Controller)]
      │ (2. ส่งรูปสลิปไปประมวลผล)
      ▼
[🐍 Python API on Vercel]
      ├── Line-Item OCR (อ่านสลิปยาวแยกบรรทัด)
      ├── Fuzzy Matching (จับคู่ชื่อสินค้าในสลิป ➔ Master Item)
      └── Dynamic PromptPay QR Generator (คำนวณยอดโอนคืน)
      │ (3. ส่งข้อมูล JSON กลับมา)
      ▼
[📱 PWA Web App (Interactive Review Screen)]
      │ (4. ผู้ใช้ตรวจสอบ / กดสลับ [กิน]/[ใช้] / เลือก Master Item)
      ▼
[⚡ Google Apps Script (Controller)]
      │ (5. บันทึก/ดึงข้อมูล)
      ▼
[📊 Google Sheets Database]
```

> Note: as described in the Implementation notes above, this scaffold implements the "Google Apps Script (Proxy/Controller)" boxes in the diagram as a Node.js/Express service instead, talking to the same Google Sheets database via the Sheets API.
