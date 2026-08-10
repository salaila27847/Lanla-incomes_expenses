import { useEffect, useState } from "react";
import { formatMoney, parseAmount } from "../money";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

type ItemCategory = "food" | "goods";

interface PendingSavingsItem {
  id: string;
  date: string;
  store: string | null;
  masterItemName: string;
  category: ItemCategory;
  price: number;
  quantity: number;
  discount: number;
  createdAt: string;
}

/** What the line actually cost — same shape as PriceHistory's lineTotal,
 *  since a confirmed pending item becomes exactly that kind of row. */
function pendingLineTotal(item: PendingSavingsItem): number {
  return item.price * item.quantity - item.discount;
}

export default function SavingsQR() {
  const [amount, setAmount] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [pendingItems, setPendingItems] = useState<PendingSavingsItem[]>([]);
  const [activePendingId, setActivePendingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  useEffect(() => {
    loadPending();
  }, []);

  async function loadPending() {
    try {
      const response = await fetch(`${API_BASE_URL}/qr/pending`);
      if (!response.ok) return;
      const body: { items: PendingSavingsItem[] } = await response.json();
      setPendingItems(body.items);
    } catch {
      // The pending list is a convenience view on top of the manual QR
      // form below — a network hiccup here shouldn't block that.
    }
  }

  async function showQrFor(amountThb: number, pendingId: string | null) {
    setLoading(true);
    setErrorMessage(null);
    setQrDataUrl(null);
    setActivePendingId(pendingId);
    try {
      const response = await fetch(`${API_BASE_URL}/qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_thb: amountThb }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `สร้าง QR ไม่สำเร็จ (${response.status})`);
      }
      const result: { qr_data_url: string } = await response.json();
      setQrDataUrl(result.qr_data_url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    } finally {
      setLoading(false);
    }
  }

  async function handleShowQr() {
    const amountThb = parseAmount(amount);
    if (amountThb === null || amountThb <= 0) {
      setErrorMessage("กรุณาระบุจำนวนเงินให้ถูกต้อง");
      return;
    }
    await showQrFor(amountThb, null);
  }

  async function handleConfirmTransfer(item: PendingSavingsItem) {
    setErrorMessage(null);
    try {
      const response = await fetch(
        `${API_BASE_URL}/qr/pending/${encodeURIComponent(item.id)}/confirm`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`ยืนยันไม่สำเร็จ (${response.status})`);
      setPendingItems((prev) => prev.filter((p) => p.id !== item.id));
      if (activePendingId === item.id) {
        setQrDataUrl(null);
        setActivePendingId(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    } finally {
      setConfirmingId(null);
    }
  }

  async function handleCancelPending(item: PendingSavingsItem) {
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/qr/pending/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`ลบไม่สำเร็จ (${response.status})`);
      setPendingItems((prev) => prev.filter((p) => p.id !== item.id));
      if (activePendingId === item.id) {
        setQrDataUrl(null);
        setActivePendingId(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-medium">จ่ายด้วยบัญชีเงินออม</h2>
        <p className="text-sm text-slate-400">
          ระบุยอดเงิน ระบบจะสร้าง PromptPay QR สำหรับโอนเงินคืนจากบัญชีหลักเข้าบัญชีออม
        </p>
      </div>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      {pendingItems.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">รายการรอโอนคืน</h3>
          <p className="text-xs text-slate-500">
            จ่ายด้วยเงินออม KTB ตอนสแกนสลิป — ยังไม่นับเป็นรายจ่ายจนกว่าจะโอนคืนแล้วกดยืนยัน
          </p>
          <ul className="mt-2 divide-y divide-slate-800">
            {pendingItems.map((item) => (
              <li key={item.id} className="space-y-2 py-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate">
                    {item.category === "food" ? "🍔" : "🧴"} {item.masterItemName}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatMoney(pendingLineTotal(item))} บาท
                  </span>
                </div>

                {confirmingId === item.id ? (
                  <div className="flex items-center justify-end gap-2 text-xs">
                    <span className="text-slate-400">โอนเรียบร้อยแล้วใช่ไหม?</span>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="rounded-full bg-slate-800 px-3 py-1.5"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmTransfer(item)}
                      className="rounded-full bg-emerald-700 px-3 py-1.5"
                    >
                      โอนแล้ว
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => handleCancelPending(item)}
                      className="shrink-0 px-2 py-1.5 text-slate-500"
                    >
                      ลบ
                    </button>
                    <button
                      type="button"
                      onClick={() => showQrFor(pendingLineTotal(item), item.id)}
                      disabled={loading}
                      className="shrink-0 rounded-full bg-slate-800 px-3 py-1.5 disabled:opacity-50"
                    >
                      {loading && activePendingId === item.id ? "กำลังสร้าง..." : "แสดง QR"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(item.id)}
                      className="shrink-0 rounded-full bg-amber-700 px-3 py-1.5"
                    >
                      ยืนยันว่าโอนแล้ว
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        <p className="text-xs text-slate-500">หรือระบุยอดเอง:</p>
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder="จำนวนเงิน (บาท)"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={handleShowQr}
          disabled={loading}
          className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium disabled:opacity-50"
        >
          {loading && activePendingId === null ? "กำลังสร้าง QR..." : "แสดง QR Code"}
        </button>
      </div>

      {qrDataUrl && (
        <div className="rounded-lg border border-slate-800 p-4 text-center">
          <img src={qrDataUrl} alt="PromptPay QR" className="mx-auto" />
        </div>
      )}
    </section>
  );
}
