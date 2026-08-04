# Smart Expense & Price Tracker

ระบบบันทึกรายรับ-รายจ่ายและเปรียบเทียบราคาสินค้าอัตโนมัติ เน้นการสแกนสลิปผ่าน Web App ที่แม่นยำ แยกหมวดหมู่สินค้าในสลิปเดียว และคำนวณงบประมาณได้อย่างรวดเร็ว

- Full spec: [`SPEC.md`](./SPEC.md)
- Repo layout and dev commands: [`CLAUDE.md`](./CLAUDE.md)

## Services

- [`/frontend`](./frontend) — React PWA
- [`/controller`](./controller) — Node.js/Express, owns Google Sheets
- [`/backend`](./backend) — Python/FastAPI, OCR + fuzzy matching + PromptPay QR
