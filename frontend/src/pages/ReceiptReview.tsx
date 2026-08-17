import { useEffect, useRef, useState } from "react";
import { amountOr0, formatMoney, parseAmount } from "../money";
import MasterItemPicker, {
  type MasterItem,
  type MatchCandidate,
} from "../components/MasterItemPicker";
import StorePicker from "../components/StorePicker";

type ReceiptCategory = "food" | "goods";
type PaidFrom = "spending" | "savings";

interface ReceiptLineItem {
  id: string;
  rawText: string;
  /** The raw text in the price box, per unit and before any discount — a
   *  controlled numeric input has to hold what was typed, or "12." loses
   *  its decimal point the moment it's pressed. Parse with parseAmount. */
  price: string;
  quantity: number;
  /** Raw text too. Taken off this line as a whole, not per unit. */
  discount: string;
  category: ReceiptCategory;
  masterItemName: string;
  candidates: MatchCandidate[];
  /** Whether the matcher was confident enough to fill this in itself. */
  autoMatched: boolean;
  /** Which account actually paid for this line. "savings" holds the item
   *  back from PriceHistory until the transfer-back QR is confirmed. */
  paidFrom: PaidFrom;
}

interface ScanResponseItem {
  id: string;
  raw_text: string;
  price: number;
  quantity: number;
  discount: number;
  matched: boolean;
  master_item_name: string | null;
  category: ReceiptCategory | null;
  score: number;
  candidates: MatchCandidate[];
}

interface ScanResponse {
  store: string | null;
  purchased_at: string | null;
  items: ScanResponseItem[];
  bill_discount: number;
  master_items: MasterItem[];
}

interface SlipScanResponse {
  payee: string | null;
  purchased_at: string | null;
  amount: number;
  transaction_id: string | null;
  /** The store this payee was mapped to on an earlier slip, if any. */
  suggested_store: string | null;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

type Status = "idle" | "scanning" | "reviewing" | "saving" | "saved" | "error";
type Mode = "scan" | "manual" | "slip";

/** The master item a whole-bill discount is filed under. It's a row in the
 *  same tab as everything else, so it needs a name — but it isn't a price,
 *  and the price history filters it out. */
const BILL_DISCOUNT_NAME = "ส่วนลดท้ายบิล";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "3 × 15.00 − 5.00 = 40.00 บาท" — spelled out so a wrong discount is
 *  visible before it's saved rather than only in the cycle total. */
function lineSummary(item: ReceiptLineItem): string {
  const unit = amountOr0(item.price);
  const discount = amountOr0(item.discount);
  const net = unit * item.quantity - discount;
  if (item.quantity === 1 && discount === 0) return `${formatMoney(unit)} บาท`;
  const parts = [item.quantity > 1 ? `${item.quantity} × ${formatMoney(unit)}` : formatMoney(unit)];
  if (discount > 0) parts.push(`− ${formatMoney(discount)}`);
  return `${parts.join(" ")} = ${formatMoney(net)} บาท`;
}

export default function ReceiptReview() {
  const [mode, setMode] = useState<Mode>("scan");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [purchasedAt, setPurchasedAt] = useState<string | null>(null);
  const [items, setItems] = useState<ReceiptLineItem[]>([]);
  const [masterItems, setMasterItems] = useState<MasterItem[]>([]);
  const [storeNames, setStoreNames] = useState<string[]>([]);
  const [savedPendingSavingsCount, setSavedPendingSavingsCount] = useState(0);
  // Set only by a slip scan — the amount actually transferred, which the
  // entered items must add up to exactly before saving is allowed. null
  // means "not in slip mode" as much as "not scanned yet".
  const [slipAmount, setSlipAmount] = useState<number | null>(null);
  const [slipPayee, setSlipPayee] = useState<string | null>(null);
  const [slipTransactionId, setSlipTransactionId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/receipt/master-items`)
      .then((response) => (response.ok ? response.json() : { master_items: [] }))
      .then((body) => setMasterItems(body.master_items))
      .catch(() => setMasterItems([]));
    fetch(`${API_BASE_URL}/receipt/store-names`)
      .then((response) => (response.ok ? response.json() : { store_names: [] }))
      .then((body) => setStoreNames(body.store_names))
      .catch(() => setStoreNames([]));
  }, []);

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setStatus("scanning");
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append("image", file);
      const response = await fetch(`${API_BASE_URL}/receipt/scan`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`สแกนไม่สำเร็จ (${response.status})`);
      }
      const result: ScanResponse = await response.json();
      setStore(result.store);
      setPurchasedAt(result.purchased_at ?? today());
      if (result.master_items) setMasterItems(result.master_items);
      setItems(
        result.items.map((item) => ({
          id: item.id,
          rawText: item.raw_text,
          price: String(item.price),
          quantity: item.quantity ?? 1,
          discount: item.discount ? String(item.discount) : "",
          category: item.category ?? "food",
          masterItemName: item.master_item_name ?? "",
          candidates: item.candidates ?? [],
          autoMatched: item.matched,
          paidFrom: "spending",
        })),
      );
      // A discount off the whole receipt belongs to no single product, so
      // it gets its own line rather than being spread across the others —
      // spreading it would corrupt every unit price on the bill.
      if (result.bill_discount > 0) {
        setItems((prev) => [
          ...prev,
          {
            id: `bill-discount-${Date.now()}`,
            rawText: "ส่วนลดท้ายบิล",
            price: "0",
            quantity: 1,
            discount: String(result.bill_discount),
            category: "food",
            masterItemName: BILL_DISCOUNT_NAME,
            candidates: [],
            autoMatched: false,
            paidFrom: "spending",
          },
        ]);
      }
      setStatus("reviewing");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
      setStatus("error");
    }
  }

  async function handleSlipFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setStatus("scanning");
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append("image", file);
      const response = await fetch(`${API_BASE_URL}/receipt/scan-slip`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`สแกนไม่สำเร็จ (${response.status})`);
      }
      const result: SlipScanResponse = await response.json();
      // No line items yet — a slip carries no product list, only who was
      // paid and how much. The user builds the items below until they add
      // up to slipAmount; see the reconciliation gate on canSave.
      setStore(result.suggested_store ?? result.payee);
      setPurchasedAt(result.purchased_at ?? today());
      setSlipAmount(result.amount);
      setSlipPayee(result.payee);
      setSlipTransactionId(result.transaction_id);
      setItems([]);
      setStatus("reviewing");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
      setStatus("error");
    }
  }

  function patchItem(id: string, patch: Partial<ReceiptLineItem>) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function addBlankLine() {
    setItems((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}-${prev.length}`,
        rawText: "",
        price: "",
        discount: "",
        quantity: 1,
        category: "food",
        masterItemName: "",
        candidates: [],
        autoMatched: false,
        paidFrom: "spending",
      },
    ]);
    if (!purchasedAt) setPurchasedAt(today());
    setStatus("reviewing");
  }

  const total = items.reduce(
    (sum, item) => sum + amountOr0(item.price) * item.quantity - amountOr0(item.discount),
    0,
  );
  // Slip mode has a real transferred amount to reconcile against; a
  // fraction of a satang is float noise, not a real shortfall.
  const remaining = slipAmount !== null ? Math.round((slipAmount - total) * 100) / 100 : null;
  const reconciled = remaining === null || Math.abs(remaining) < 0.005;

  const canSave =
    items.length > 0 &&
    items.every(
      (item) => item.masterItemName.trim().length > 0 && parseAmount(item.price) !== null,
    ) &&
    reconciled;
  // Slip mode shows the editor as soon as the slip is scanned, even before
  // any item exists — that's the point of the reconciliation gimmick: the
  // running "remaining" total is what nudges the user to add lines.
  const showEditor = items.length > 0 || slipAmount !== null;

  async function handleSave() {
    setStatus("saving");
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/receipt/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store,
          purchased_at: purchasedAt ?? today(),
          items: items.map((item) => ({
            raw_text: item.rawText || item.masterItemName,
            price: amountOr0(item.price),
            quantity: item.quantity,
            discount: amountOr0(item.discount),
            master_item_name: item.masterItemName.trim(),
            category: item.category,
            paid_from: item.paidFrom,
          })),
          ...(slipAmount !== null
            ? { slip: { payee: slipPayee, amount: slipAmount, transaction_id: slipTransactionId } }
            : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`บันทึกไม่สำเร็จ (${response.status})`);
      }
      setSavedPendingSavingsCount(items.filter((item) => item.paidFrom === "savings").length);
      setItems([]);
      setStore(null);
      setSlipAmount(null);
      setSlipPayee(null);
      setSlipTransactionId(null);
      setStatus("saved");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
      setStatus("error");
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">เพิ่มรายจ่าย</h2>
        <p className="text-sm text-slate-400">
          สแกนสลิปรายการสินค้า สแกนสลิปโอนเงิน หรือกรอกเองทีละรายการ
        </p>
      </div>

      <div className="flex gap-2">
        {(
          [
            ["scan", "📷 สแกนสลิป"],
            ["slip", "🧾 สลิปโอนเงิน"],
            ["manual", "✏️ กรอกเอง"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setMode(value);
              // The reconciliation gate is a slip-mode thing; leaving it
              // active while working in manual/scan mode would block a
              // save that has nothing to do with any slip.
              if (value !== "slip" && slipAmount !== null) {
                setSlipAmount(null);
                setSlipPayee(null);
                setSlipTransactionId(null);
              }
            }}
            className={`flex-1 rounded-lg py-2 text-sm ${
              mode === value ? "bg-sky-600" : "bg-slate-800 text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "manual" ? (
        <button
          type="button"
          onClick={addBlankLine}
          className="w-full rounded-lg border border-dashed border-slate-700 py-6 text-sm text-slate-400"
        >
          ＋ เพิ่มรายการ
        </button>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={mode === "slip" ? handleSlipFileSelected : handleFileSelected}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={status === "scanning" || status === "saving"}
            className="w-full rounded-lg border border-dashed border-slate-700 py-6 text-sm text-slate-400 disabled:opacity-50"
          >
            {status === "scanning"
              ? "กำลังสแกน..."
              : mode === "slip"
                ? "แตะเพื่อถ่าย/เลือกรูปสลิปโอนเงิน"
                : "แตะเพื่อถ่าย/เลือกรูปสลิป"}
          </button>
        </>
      )}

      {status === "error" && errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}
      {status === "saved" && (
        <p className="text-sm text-emerald-400">
          บันทึกสำเร็จ
          {savedPendingSavingsCount > 0 &&
            ` — มี ${savedPendingSavingsCount} รายการรอโอนคืนเข้าบัญชีออม ไปที่หน้า QR Code เพื่อยืนยัน`}
        </p>
      )}

      {!showEditor ? (
        <p className="text-sm text-slate-500">ยังไม่มีรายการ</p>
      ) : (
        <>
          {slipAmount !== null && (
            <div
              className={`space-y-1 rounded-lg border p-3 text-sm ${
                reconciled
                  ? "border-emerald-800 bg-emerald-950/40"
                  : "border-amber-800 bg-amber-950/40"
              }`}
            >
              <div className="flex items-center justify-between text-slate-400">
                <span>ยอดสลิป</span>
                <span className="tabular-nums text-slate-200">{formatMoney(slipAmount)} บาท</span>
              </div>
              <div
                className={`flex items-center justify-between font-medium ${
                  reconciled ? "text-emerald-400" : "text-amber-400"
                }`}
              >
                <span>คงเหลือที่ยังไม่ลงรายการ</span>
                <span className="tabular-nums">{formatMoney(remaining ?? 0)} บาท</span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div>
              <p className="text-xs text-slate-500">ร้าน</p>
              <div className="mt-1">
                <StorePicker value={store} storeNames={storeNames} onChange={setStore} />
              </div>
            </div>
            <label className="block text-xs text-slate-500">
              วันที่
              <input
                type="date"
                value={purchasedAt ?? today()}
                onChange={(event) => setPurchasedAt(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              />
            </label>
          </div>

          <ul className="divide-y divide-slate-800">
            {items.map((item) => (
              <li key={item.id} className="space-y-2 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs text-slate-500">
                    {item.rawText || "รายการที่กรอกเอง"}
                  </p>
                  <button
                    type="button"
                    onClick={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
                    className="shrink-0 px-2 text-xs text-slate-500"
                    aria-label="ลบรายการนี้"
                  >
                    ✕
                  </button>
                </div>

                <MasterItemPicker
                  value={item.masterItemName}
                  masterItems={masterItems}
                  candidates={item.candidates}
                  suggestedNewName={item.rawText}
                  onChange={(name, category) =>
                    patchItem(item.id, {
                      masterItemName: name,
                      ...(category ? { category } : {}),
                    })
                  }
                />

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      patchItem(item.id, {
                        category: item.category === "food" ? "goods" : "food",
                      })
                    }
                    className="shrink-0 rounded-full bg-slate-800 px-3 py-2 text-sm"
                  >
                    {item.category === "food" ? "🍔 กิน" : "🧴 ใช้"}
                  </button>

                  {/* Doesn't touch PriceHistory directly — a savings-paid
                      line waits in the QR page's pending list until the
                      transfer-back is actually confirmed. */}
                  <button
                    type="button"
                    onClick={() =>
                      patchItem(item.id, {
                        paidFrom: item.paidFrom === "savings" ? "spending" : "savings",
                      })
                    }
                    className={`shrink-0 rounded-full px-3 py-2 text-sm ${
                      item.paidFrom === "savings" ? "bg-amber-700" : "bg-slate-800"
                    }`}
                  >
                    {item.paidFrom === "savings" ? "💰 เงินออม KTB" : "บัญชีหลัก"}
                  </button>

                  <div className="flex shrink-0 items-center rounded-full bg-slate-800">
                    <button
                      type="button"
                      onClick={() =>
                        patchItem(item.id, { quantity: Math.max(1, item.quantity - 1) })
                      }
                      className="px-3 py-2 text-sm"
                      aria-label="ลดจำนวน"
                    >
                      −
                    </button>
                    <span className="min-w-6 text-center text-sm tabular-nums">
                      {item.quantity}
                    </span>
                    <button
                      type="button"
                      onClick={() => patchItem(item.id, { quantity: item.quantity + 1 })}
                      className="px-3 py-2 text-sm"
                      aria-label="เพิ่มจำนวน"
                    >
                      ＋
                    </button>
                  </div>

                  <input
                    value={item.price}
                    onChange={(event) => patchItem(item.id, { price: event.target.value })}
                    inputMode="decimal"
                    aria-label="ราคาต่อชิ้น"
                    className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-sm"
                  />
                </div>

                <div className="flex items-center justify-end gap-2">
                  <label className="text-xs text-slate-500">ส่วนลด</label>
                  <input
                    value={item.discount}
                    onChange={(event) => patchItem(item.id, { discount: event.target.value })}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label="ส่วนลดของรายการนี้"
                    className="w-24 rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-right text-sm"
                  />
                </div>

                <p className="text-right text-xs text-slate-500">
                  {parseAmount(item.price) === null ? "ใส่ราคา" : lineSummary(item)}
                </p>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">รวม</span>
            <span className="tabular-nums">{formatMoney(total)} บาท</span>
          </div>

          <button
            type="button"
            onClick={addBlankLine}
            className="w-full rounded-lg border border-slate-800 py-2 text-sm text-slate-400"
          >
            {mode === "slip" ? "＋ เพิ่มรายการ" : "＋ เพิ่มรายการที่สลิปอ่านไม่เจอ"}
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || status === "saving"}
            className="w-full rounded-lg bg-sky-600 py-3 text-sm font-medium disabled:opacity-50"
          >
            {status === "saving" ? "กำลังบันทึก..." : "บันทึก"}
          </button>
          {!canSave &&
            (!reconciled ? (
              <p className="text-center text-xs text-amber-400">
                ลงรายการให้ครบยอดสลิป (คงเหลือ {formatMoney(remaining ?? 0)} บาท) ก่อนถึงจะบันทึกได้
              </p>
            ) : (
              <p className="text-center text-xs text-amber-400">
                ใส่ชื่อสินค้าและราคาให้ครบทุกรายการก่อนบันทึก
              </p>
            ))}
        </>
      )}
    </section>
  );
}
