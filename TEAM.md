# โครงสร้างทีมพัฒนา (AI Agent Team)

เอกสารนี้เสนอวิธีจัดทีม — ในที่นี้คือทีม "เอเจนต์ AI" (Claude Code subagents) ไม่ใช่ทีมมนุษย์ — สำหรับพัฒนา Smart Expense & Price Tracker ต่อ โดยเน้นสองอย่างพร้อมกัน: **ประสิทธิภาพงาน** (แบ่งงานให้ตรงกับโครงสร้าง monorepo จริง) และ **ความคุ้มค่าโทเค็น** (แต่ละคนโหลด context เท่าที่จำเป็นเท่านั้น)

## หลักคิดเรื่องโทเค็น

Repo นี้เป็น monorepo 3 service ที่ **ไม่มี build tooling ร่วมกัน** (ดู CLAUDE.md ส่วน Architecture) — นี่คือเส้นแบ่งทีมที่ธรรมชาติที่สุดอยู่แล้ว ไม่ต้องประดิษฐ์ขึ้นใหม่ตามฟีเจอร์ เพราะ:

- **แบ่งตาม service boundary ไม่ใช่ตามฟีเจอร์** — คนที่แก้ `/frontend` ไม่จำเป็นต้องรู้รายละเอียด Sheets API หรือ FastAPI routers ลึก ๆ รู้แค่ API contract ก็พอ การจำกัด scope แบบนี้ทำให้แต่ละ agent อ่านโค้ดน้อยลงต่องานหนึ่งชิ้นโดยตรง
- **ทีมเล็กและ specialized ดีกว่าทีมใหญ่แบบ generalist** — การ spawn agent ใหม่ทุกครั้งต้อง "re-derive context" ใหม่หมด (คือต้นทุนโทเค็นจริง) ทีมที่มี role คงที่ ไม่ต้องอธิบายบริบทซ้ำทุกครั้งที่เรียกงาน คุ้มกว่าการเปิด agent ทั่วไปมาทำทุกอย่าง
- **เลือกโมเดลตามความยากของงาน** — งานที่ต้องตัดสินใจเชิงสถาปัตยกรรม/dosmain logic ที่ละเอียดอ่อน (เช่น กติกา pay cycle, unit price/discount) ใช้โมเดลที่คิดลึกกว่า งานที่ทำซ้ำตาม pattern เดิม (รันเทส, เขียนโค้ดตามโครงที่มีอยู่แล้ว) ใช้โมเดลที่เบากว่าได้
- **ใช้ Explore agent สำหรับงานค้นหา** แทนให้ทุก role อ่านทั้ง repo เอง
- **ใช้ isolation แบบ worktree** เมื่อให้หลาย role ทำงานพร้อมกันแบบขนานบนไฟล์คนละส่วน เพื่อไม่ให้ diff ชนกัน
- **Reuse skill ที่มีอยู่แล้ว** (`code-review`, `security-review`, `run`) แทนสั่งงานรีวิว/ทดสอบแบบ ad-hoc ทุกครั้ง

## โครงสร้างทีม (5 roles)

### 1. Orchestrator / Tech Lead
**หน้าที่:** รับ requirement จาก `SPEC.md`/ผู้ใช้ → แตกเป็น task ย่อยตาม service → มอบหมายให้ role ที่เหมาะสม → รวมผลลัพธ์ → ตัดสินใจ trade-off ที่กระทบหลาย service (เช่น data flow ระหว่าง backend→controller→Sheets) → merge PR

**สกิลที่ต้องมี:** เข้าใจภาพรวม data flow ทั้งระบบ, อ่าน `SPEC.md` + `CLAUDE.md` ทะลุ (โดยเฉพาะส่วน pay cycle / unit price-discount / master item matching ที่เป็นกติกาละเอียดอ่อนของโปรเจกต์นี้), ไม่ลงมือเขียนโค้ดเองยกเว้นงานเล็กที่ข้ามหลาย service

**โมเดลแนะนำ:** Opus — เรียกไม่บ่อยเพราะงานส่วนใหญ่ delegate ต่อ แต่ตอนตัดสินใจต้องคิดลึก

### 2. Frontend Engineer — scope: `/frontend` เท่านั้น
**สกิลที่ต้องมี:** React + TypeScript, Vite, Tailwind CSS, `vite-plugin-pwa`/PWA offline patterns, edge case ของ controlled numeric input (`money.ts` / `parseAmount` — ทำไมห้าม `Number(x) || 0`), mobile-first layout (ยกเว้นหน้า Dashboard ที่กว้าง 12 คอลัมน์), vitest สำหรับ pure helper

**ขอบเขต context:** อ่านเฉพาะ `frontend/` + ส่วน frontend ของ `SPEC.md` รู้แค่ API contract ของ controller ไม่ต้องรู้ implementation ฝั่ง Sheets/Python

**โมเดลแนะนำ:** Sonnet

### 3. Platform Engineer (Controller + Backend) — scope: `/controller` + `/backend`
**สกิลที่ต้องมี:** Node/Express/TypeScript (Google Sheets API ผ่าน `googleapis`, service-account auth), Python/FastAPI (deploy เป็น Vercel serverless), และกติกาโดเมนเฉพาะของโปรเจกต์นี้ — `cycles.ts` (partition กฎ pay cycle), ความหมายของ `price`/`quantity`/`discount`/`lineTotal`, threshold การ fuzzy match (`rapidfuzz`, `WRatio`, 60/90), PromptPay EMVCo payload

**ทำไมรวมสอง service เป็น role เดียว:** ฟีเจอร์ส่วนใหญ่ของโปรเจกต์นี้ต้องแตะทั้งคู่พร้อมกันอยู่แล้ว (เช่น scan receipt: backend OCR → controller เขียน Sheets) แยกเป็นสอง role จะเพิ่ม coordination overhead (และโทเค็นสำหรับส่งบริบทข้าม role) โดยไม่คุ้มสำหรับขนาดโปรเจกต์นี้

**โมเดลแนะนำ:** Sonnet ตามปกติ, สลับเป็น Opus เฉพาะตอนแก้ business rule ที่ละเอียดอ่อน (เช่น cycle naming, discount-only row)

### 4. QA / Test Engineer — cross-cutting, เข้าเฉพาะตอนรัน/เขียนเทส
**สกิลที่ต้องมี:** pytest, vitest + supertest, vitest (frontend pure helper), รู้กติกา "fake time" (`vi.setSystemTime` — ทดสอบเรื่อง cycle/date ต้อง pin เวลาเสมอ), รู้ mock pattern ของโปรเจกต์ (`OCR_MOCK_MODE`, `SHEETS_MOCK_MODE`, `httpx.MockTransport`), รู้หลัก "เลือก anchor ที่ implementation เปลี่ยนไม่ได้" (เช่น CRC-16 test vector ใน `test_promptpay.py`, ตาราง 12 payday→month ใน `cycles.test.ts`)

**Trigger:** รันหลังทุกการเปลี่ยนแปลง ก่อน commit — ทั้ง 3 test suite รันแบบ offline ได้ ไม่ต้องมี API key

**โมเดลแนะนำ:** Sonnet หรือ Haiku — งานรันเทส/เขียนเทสตาม pattern เดิมเป็นงานทำซ้ำ ไม่จำเป็นต้องใช้โมเดลแพง

### 5. Reviewer (Code + Security) — cross-cutting
**สกิลที่ต้องมี:** ใช้ skill `code-review` (correctness, simplification, efficiency) และ `security-review` ก่อน merge ทุก PR โฟกัส OWASP top 10, การจัดการ secret (`.env`, service-account key), validation ที่ boundary เท่านั้น (ไม่ validate ภายในที่ trust ได้อยู่แล้ว)

**โมเดลแนะนำ:** เลือก level ตามขนาด diff — `low`/`medium` สำหรับ PR ทั่วไป, `high` เมื่อ diff ใหญ่หรือแตะ security/auth

## Workflow แนะนำ

1. Orchestrator อ่าน requirement ครั้งเดียว แตก task ตาม service
2. Frontend Engineer และ Platform Engineer ทำงานขนานกัน (ใช้ `isolation: worktree` ถ้าแก้ไฟล์คนละส่วนแต่กลัวชนกัน) คุยกันผ่าน "API contract" สั้น ๆ ไม่ต้องแชร์ context เต็ม
3. แต่ละ role รันเทสของ service ตัวเองก่อนส่งต่อ
4. QA รันทั้ง 3 suite รวมกัน (offline, ไม่ต้องใช้เครดิต API ภายนอก)
5. Reviewer รีวิว diff รวมก่อน merge
6. Orchestrator merge แล้วอัปเดต `CLAUDE.md`/`SPEC.md` เฉพาะเมื่อ behavior เปลี่ยนจริง — บันทึกเหตุผล (WHY) ไม่ใช่แค่สรุปว่าเปลี่ยนอะไร

## กติกาลดโทเค็นที่ควรยึดตลอด

- อย่า spawn agent ใหม่ถ้า subagent เดิมที่ทำงานค้างอยู่ตอบได้ — สานต่อ conversation เดิมแทนเปิดใหม่
- จำกัด tool access ต่อ role (เช่น Frontend Engineer ไม่ต้องมีสิทธิ์แตะ Google Sheets/Vercel)
- ใช้ Explore agent (read-only, เร็ว) แทนให้ทุก role อ่านทั้ง repo เอง
- เขียน description ของแต่ละ subagent ให้แคบและชัดเจน เพื่อไม่ต้องอธิบาย context ซ้ำทุกครั้งที่เรียกใช้
- Reuse skill ที่มีอยู่แล้วในระบบแทนสั่งงานแบบ ad-hoc ทุกครั้ง

## ตัวอย่าง subagent config (`.claude/agents/*.md`)

ถ้าต้องการนำไปใช้จริงใน Claude Code ให้สร้างไฟล์ตาม role ข้างต้น เช่น:

```markdown
---
name: frontend-engineer
description: React/TypeScript/Vite/Tailwind work scoped to /frontend — ReceiptReview, PriceHistory, Budget, Dashboard, SavingsQR pages, PWA config, and frontend vitest suite. Use for any change confined to the frontend service.
tools: Read, Edit, Write, Glob, Grep, Bash
model: sonnet
---
```

```markdown
---
name: platform-engineer
description: Node/Express/TypeScript (controller, Google Sheets) and Python/FastAPI (backend, OCR/matching/QR) work scoped to /controller and /backend. Use for changes touching Sheets tabs, pay-cycle logic, price/discount semantics, master-item matching, or PromptPay QR.
tools: Read, Edit, Write, Glob, Grep, Bash
model: sonnet
---
```

```markdown
---
name: qa-engineer
description: Runs and writes tests across all three services (pytest, vitest+supertest, vitest). Use after any code change and before commit; knows the project's offline mocking conventions (OCR_MOCK_MODE, SHEETS_MOCK_MODE, httpx.MockTransport) and fake-time testing rules.
tools: Read, Edit, Bash, Glob, Grep
model: sonnet
---
```

โครงสร้างนี้ตั้งใจให้เล็กพอที่จะดูแลง่าย แต่ครอบคลุมทุกขอบเขตของ repo — ขยาย role เพิ่มได้เมื่อโปรเจกต์โตขึ้นจริง (เช่น แยก DevOps/Deploy role เมื่อเริ่มมี Vercel deployment ที่ซับซ้อนขึ้น) แต่ไม่ควรตั้งไว้ตั้งแต่ต้นเพราะจะเพิ่ม coordination overhead โดยยังไม่มีงานมารองรับ

## ตัวอย่างการใช้งานจริง: เพิ่มปุ่ม "Export CSV" ในหน้า Price History

โจทย์สมมติ (ขนาดเล็ก เกิดขึ้นจริงได้): "ผู้ใช้อยากกดปุ่มแล้วโหลดผลค้นหาใน Price History เป็นไฟล์ CSV ไปเปิดใน Excel เอง" ฟีเจอร์นี้แตะ `controller` (route ใหม่) และ `frontend` (ปุ่ม+ดาวน์โหลด) เท่านั้น — ไม่ต้องแตะ `backend` (Python) เพราะไม่เกี่ยวกับ OCR/matching/QR เลย นี่คือจุดที่การแบ่งทีมตาม service บอกได้ทันทีว่า **ไม่ต้องเรียก Platform Engineer ไปอ่าน `/backend` เลยด้วยซ้ำ** — ประหยัดโทเค็นตั้งแต่ขั้นวางแผน

### ขั้นที่ 1 — Orchestrator แตกงาน

Orchestrator อ่านโจทย์ เปิดดู `controller/src/routes/prices.ts` (มี logic กรอง/จัดกลุ่มอยู่แล้วใน `GET /`) และ `frontend/src/pages/PriceHistory.tsx` (มี state `groups`/`query` อยู่แล้ว) แล้วเขียน "สัญญา" สั้น ๆ ให้แต่ละ role แทนที่จะให้แต่ละ role ไปสำรวจเองทั้ง repo:

> **API contract:** `GET /prices/export?item=<คำค้น>` → คืน `text/csv` คอลัมน์ `store,masterItemName,price,quantity,discount,netPrice,date` โดยใช้ logic กรอง/จัดกลุ่มเดียวกับ `GET /prices` (ห้าม duplicate) — แถวที่ `isDiscountOnly` เป็น true ต้องถูกกรองออกเหมือนกัน

จากนั้นมอบงานสองก้อนแบบขนาน:

```
Agent({
  description: "Add CSV export route",
  subagent_type: "platform-engineer",
  prompt: "เพิ่ม GET /prices/export?item=... ใน controller/src/routes/prices.ts
    ให้ reuse filter/group logic เดิมจาก GET / (แยกเป็นฟังก์ชันร่วมถ้าจำเป็น
    อย่าคัดลอกเงื่อนไข isDiscountOnly ซ้ำ) ตอบกลับเป็น text/csv, header:
    store,masterItemName,price,quantity,discount,netPrice,date
    เขียน supertest ใน prices.test.ts คู่กับ route เดิม"
})

Agent({
  description: "Add CSV export button to PriceHistory",
  subagent_type: "frontend-engineer",
  prompt: "ในหน้า frontend/src/pages/PriceHistory.tsx เพิ่มปุ่ม 'Export CSV'
    ข้าง search box, disabled เมื่อ groups เป็น null/ว่าง, กดแล้ว fetch
    `${API_BASE_URL}/prices/export?item=...` แล้ว trigger browser download
    (ไม่ต้องใช้ library เพิ่ม ใช้ Blob + URL.createObjectURL พอ)"
})
```

สังเกตว่า prompt ทั้งสองก้อนสั้น เพราะแต่ละ subagent มี `description` ที่ตั้ง scope ไว้ล่วงหน้าอยู่แล้ว (ไม่ต้องอธิบายทั้งโปรเจกต์ซ้ำทุกครั้ง) — นี่คือส่วนที่ประหยัดโทเค็นจริง ๆ เทียบกับการเปิด agent ทั่วไปแล้วต้องบรีฟทั้ง repo ใหม่ทุกครั้ง

### ขั้นที่ 2 — สองงานรันขนาน ไม่ชนกัน

Platform Engineer แก้เฉพาะ `controller/src/routes/prices.ts` + `controller/src/routes/prices.test.ts`; Frontend Engineer แก้เฉพาะ `frontend/src/pages/PriceHistory.tsx` — คนละไฟล์คนละ service จึงไม่ต้องรอกันหรือใช้ `isolation: worktree` เลยด้วยซ้ำ (เก็บ worktree ไว้ใช้เฉพาะตอนสอง role มีโอกาสแก้ไฟล์เดียวกันจริง ๆ) ระหว่างทาง Platform Engineer พบว่า logic กรอง/จัดกลุ่มใน `GET /` เขียนแบบ inline ในตัว handler จึงต้องแตกเป็นฟังก์ชัน `buildPriceGroups()` ก่อนแล้วให้ทั้งสอง route เรียกใช้ร่วมกัน — เป็นการตัดสินใจระดับไฟล์เดียวที่ role นี้ทำเองได้โดยไม่ต้องถาม Orchestrator

### ขั้นที่ 3 — QA

QA Engineer ไม่ต้องรัน `pytest` ของ `/backend` เลย (ไม่มีไฟล์ backend เปลี่ยน) รันแค่:
```
cd controller && npm test   # ครอบทั้ง route เดิมและ route ใหม่
cd frontend && npm test     # ครอบ pure helper ที่ไม่แตะ (regression check เร็ว ๆ)
```
นี่คือจุดที่ "รู้ scope ของ diff" ช่วยตัดงานที่ไม่จำเป็นออกไปได้ทั้งก้อน (suite ของ backend) แทนที่จะรันทั้ง 3 suite ทุกครั้งแบบไม่คิด

### ขั้นที่ 4 — Reviewer

เรียก skill `code-review` กับ diff รวมของทั้งสองไฟล์ ประเด็นที่ควรเจอในตัวอย่างนี้:
- CSV injection: ถ้า `masterItemName` ขึ้นต้นด้วย `=`/`+`/`-`/`@` แล้วเปิดใน Excel อาจถูกตีความเป็นสูตร — reviewer ควรทักถ้า Platform Engineer ไม่ได้ escape
- ยืนยันว่า route ใหม่ reuse `buildPriceGroups()` จริง ไม่ได้ copy เงื่อนไข `isDiscountOnly` ซ้ำ (ตรงตาม contract ที่ Orchestrator ตั้งไว้)
- ไม่มี secret/credential หลุดในทั้งสองไฟล์

### ขั้นที่ 5 — Orchestrator merge

เพราะฟีเจอร์นี้เป็นแค่ "อ่านข้อมูลเดิมแล้วส่งออก" ไม่ได้เปลี่ยนกติกาโดเมนใด ๆ (unit price/discount/pay cycle ยังเหมือนเดิมทุกอย่าง) จึง **ไม่ต้องแก้ `CLAUDE.md`/`SPEC.md`** — Orchestrator merge ตรง ๆ ได้เลย นี่คือตัวอย่างของการ "ไม่ทำงานเกินคำขอ" ที่ทีมนี้ควรยึดไว้เสมอ

### เทียบโทเค็นคร่าว ๆ กับแบบไม่มีทีม

| | Agent เดียวไม่มี scope | ทีม 5 role ตามข้างบน |
|---|---|---|
| ต้องอ่านอะไรก่อนเริ่ม | สำรวจทั้ง repo (frontend+controller+backend) เพื่อหาว่าไฟล์ไหนเกี่ยวข้อง | Orchestrator ชี้ไฟล์ที่เกี่ยวมาให้ตรง ๆ 2 ไฟล์หลัก |
| context ที่ต้องบรีฟ | อธิบายทั้งโปรเจกต์ใหม่ทุกครั้งที่เริ่ม session | ไม่ต้อง — อยู่ใน `description` ของ subagent อยู่แล้ว |
| test suite ที่รัน | มักรันทั้ง 3 suite เพราะไม่แน่ใจว่ากระทบอะไรบ้าง | รันแค่ 2 suite ที่ diff แตะจริง |
| งานขนานได้ไหม | ทำทีละอย่างในบทสนทนาเดียว | frontend/controller ทำพร้อมกันได้ |

ตัวเลขในตารางเป็นทิศทางเชิงคุณภาพเพื่อให้เห็นภาพ ไม่ใช่การวัดจริง — แต่รูปแบบนี้ (จำกัด scope ตั้งแต่ต้น, รู้ล่วงหน้าว่าตัดอะไรออกได้) คือกลไกจริงที่ทำให้ประหยัดโทเค็น ไม่ใช่แค่ "มีหลาย agent" เฉย ๆ
