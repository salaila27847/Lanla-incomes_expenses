import { useEffect, useState } from "react";
import { formatMoney, parseAmount } from "../money";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

const THAI_MONTHS = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${THAI_MONTHS[month - 1]}`;
}

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

interface IncomeEntry {
  id: string;
  date: string;
  source: string;
  amount: number;
  destinationAccount: "spending" | "savings";
}

interface SavingsWithdrawal {
  id: string;
  date: string;
  masterItemName: string;
  category: ItemCategory;
  amount: number;
  confirmedAt: string;
}

interface SavingsMovement {
  id: string;
  /** The underlying Income or SavingsWithdrawal row's own id -- what an
   *  edit or delete actually targets, as opposed to `id` above, which is
   *  only unique within this merged list. */
  sourceId: string;
  date: string;
  label: string;
  amount: number;
  direction: "in" | "out";
}

interface MovementDateGroup {
  date: string;
  movements: SavingsMovement[];
}

/** What the line actually cost — same shape as PriceHistory's lineTotal,
 *  since a confirmed pending item becomes exactly that kind of row. */
function pendingLineTotal(item: PendingSavingsItem): number {
  return item.price * item.quantity - item.discount;
}

/** Savings-tagged income (in) and confirmed permanent withdrawals (out),
 *  merged into one newest-first timeline. A transfer-back-settled pending
 *  item isn't included here -- it nets the savings balance to unchanged,
 *  so there's no real movement to show for it. */
export function buildSavingsMovements(
  income: IncomeEntry[],
  withdrawals: SavingsWithdrawal[],
): SavingsMovement[] {
  const inMovements: SavingsMovement[] = income.map((entry) => ({
    id: `income-${entry.id}`,
    sourceId: entry.id,
    date: entry.date,
    label: entry.source,
    amount: entry.amount,
    direction: "in",
  }));
  const outMovements: SavingsMovement[] = withdrawals.map((withdrawal) => ({
    id: `withdrawal-${withdrawal.id}`,
    sourceId: withdrawal.id,
    date: withdrawal.date,
    label: withdrawal.masterItemName,
    amount: withdrawal.amount,
    direction: "out",
  }));
  return [...inMovements, ...outMovements].sort((a, b) => b.date.localeCompare(a.date));
}

/** Buckets an already-sorted (newest-first) list into consecutive
 *  same-date runs, same idea as Budget's groupExpensesByDate. */
export function groupMovementsByDate(movements: SavingsMovement[]): MovementDateGroup[] {
  const groups: MovementDateGroup[] = [];
  for (const movement of movements) {
    const current = groups[groups.length - 1];
    if (current && current.date === movement.date) current.movements.push(movement);
    else groups.push({ date: movement.date, movements: [movement] });
  }
  return groups;
}

type PendingAction = "transfer-back" | "deduct";

export default function SavingsQR() {
  const [amount, setAmount] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [pendingItems, setPendingItems] = useState<PendingSavingsItem[]>([]);
  const [activePendingId, setActivePendingId] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<{ id: string; action: PendingAction } | null>(
    null,
  );

  const [movements, setMovements] = useState<SavingsMovement[]>([]);
  const [editingMovement, setEditingMovement] = useState<{
    sourceId: string;
    direction: "in" | "out";
  } | null>(null);

  useEffect(() => {
    loadPending();
    loadMovements();
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

  /** This cycle's savings-account movements: savings-tagged Income (in)
   *  and confirmed permanent withdrawals (out). */
  async function loadMovements() {
    try {
      const budgetResponse = await fetch(`${API_BASE_URL}/budget`);
      if (!budgetResponse.ok) return;
      const budget: { cycle: { key: string } | null } = await budgetResponse.json();
      if (!budget.cycle) return;

      const [incomeResponse, withdrawalsResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/income?cycle=${budget.cycle.key}`),
        fetch(`${API_BASE_URL}/qr/withdrawals?cycle=${budget.cycle.key}`),
      ]);
      const income: IncomeEntry[] = incomeResponse.ok
        ? (await incomeResponse.json()).entries.filter(
            (entry: IncomeEntry) => entry.destinationAccount === "savings",
          )
        : [];
      const withdrawals: SavingsWithdrawal[] = withdrawalsResponse.ok
        ? (await withdrawalsResponse.json()).withdrawals
        : [];
      setMovements(buildSavingsMovements(income, withdrawals));
    } catch {
      // Same reasoning as loadPending — a supplementary view, not load-bearing.
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

  function clearPendingItem(id: string) {
    setPendingItems((prev) => prev.filter((p) => p.id !== id));
    if (activePendingId === id) {
      setQrDataUrl(null);
      setActivePendingId(null);
    }
    setActiveAction(null);
  }

  // The spending account pays the savings account back — same meaning as
  // before, just reached through an explicit choice now instead of the
  // page's one and only confirm button.
  async function handleConfirmTransfer(item: PendingSavingsItem) {
    setErrorMessage(null);
    try {
      const response = await fetch(
        `${API_BASE_URL}/qr/pending/${encodeURIComponent(item.id)}/confirm`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`ยืนยันไม่สำเร็จ (${response.status})`);
      clearPendingItem(item.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  // The savings account keeps the cost permanently instead — no transfer,
  // no QR. Lowers that cycle's SavingsBalance and shows up in the
  // movement list below.
  async function handleDeduct(item: PendingSavingsItem) {
    setErrorMessage(null);
    try {
      const response = await fetch(
        `${API_BASE_URL}/qr/pending/${encodeURIComponent(item.id)}/deduct`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`ยืนยันไม่สำเร็จ (${response.status})`);
      clearPendingItem(item.id);
      await loadMovements();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  async function handleCancelPending(item: PendingSavingsItem) {
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/qr/pending/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`ลบไม่สำเร็จ (${response.status})`);
      clearPendingItem(item.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  /** "in" movements are savings-tagged Income entries; "out" are confirmed
   *  SavingsWithdrawals -- two different tabs, so editing/deleting one
   *  targets a different route than the other. */
  function movementUrl(movement: SavingsMovement): string {
    return movement.direction === "in"
      ? `${API_BASE_URL}/income/${encodeURIComponent(movement.sourceId)}`
      : `${API_BASE_URL}/qr/withdrawals/${encodeURIComponent(movement.sourceId)}`;
  }

  async function saveMovement(movement: SavingsMovement, amount: number) {
    setErrorMessage(null);
    try {
      const response = await fetch(movementUrl(movement), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `แก้ไขไม่สำเร็จ (${response.status})`);
      }
      setEditingMovement(null);
      await loadMovements();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  async function deleteMovement(movement: SavingsMovement) {
    setErrorMessage(null);
    try {
      const response = await fetch(movementUrl(movement), { method: "DELETE" });
      if (!response.ok) throw new Error(`ลบไม่สำเร็จ (${response.status})`);
      setEditingMovement(null);
      await loadMovements();
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
            จ่ายด้วยเงินออม KTB ตอนสแกนสลิป — ยังไม่นับเป็นรายจ่ายจนกว่าจะเลือกวิธียืนยันด้านล่าง
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

                {activeAction?.id === item.id && activeAction.action === "transfer-back" ? (
                  <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setActiveAction(null)}
                      className="shrink-0 rounded-full bg-slate-800 px-3 py-1.5"
                    >
                      ยกเลิก
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
                      onClick={() => handleConfirmTransfer(item)}
                      className="shrink-0 rounded-full bg-emerald-700 px-3 py-1.5"
                    >
                      ยืนยันว่าโอนแล้ว
                    </button>
                  </div>
                ) : activeAction?.id === item.id && activeAction.action === "deduct" ? (
                  <div className="flex items-center justify-end gap-2 text-xs">
                    <span className="text-slate-400">หักออกจากยอดเงินออมถาวรใช่ไหม?</span>
                    <button
                      type="button"
                      onClick={() => setActiveAction(null)}
                      className="rounded-full bg-slate-800 px-3 py-1.5"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeduct(item)}
                      className="rounded-full bg-red-800 px-3 py-1.5"
                    >
                      ยืนยัน
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => handleCancelPending(item)}
                      className="shrink-0 px-2 py-1.5 text-slate-500"
                    >
                      ลบ
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveAction({ id: item.id, action: "deduct" })}
                      className="shrink-0 rounded-full bg-slate-800 px-3 py-1.5"
                    >
                      หักจากบัญชีเงินออม
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveAction({ id: item.id, action: "transfer-back" })}
                      className="shrink-0 rounded-full bg-amber-700 px-3 py-1.5"
                    >
                      โอนคืนบัญชีใช้จ่าย
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

      {movements.length > 0 && (
        <div>
          <h3 className="text-sm font-medium">รายการเคลื่อนไหวบัญชีออมรอบนี้</h3>
          <p className="text-xs text-slate-500">แตะที่รายการเพื่อแก้ไขหรือลบ</p>
          {groupMovementsByDate(movements).map((group, index) => (
            <div key={group.date} className={index > 0 ? "mt-3" : "mt-2"}>
              <p className="text-xs font-medium text-slate-400">{shortDate(group.date)}</p>
              <ul className="mt-1 divide-y divide-slate-800">
                {group.movements.map((movement) =>
                  editingMovement?.sourceId === movement.sourceId &&
                  editingMovement.direction === movement.direction ? (
                    <MovementEditor
                      key={movement.id}
                      movement={movement}
                      onCancel={() => setEditingMovement(null)}
                      onSave={(amount) => saveMovement(movement, amount)}
                      onDelete={() => deleteMovement(movement)}
                    />
                  ) : (
                    <li key={movement.id}>
                      <button
                        type="button"
                        onClick={() =>
                          setEditingMovement({ sourceId: movement.sourceId, direction: movement.direction })
                        }
                        className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">{movement.label}</span>
                        <span
                          className={`shrink-0 tabular-nums ${
                            movement.direction === "in" ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          {movement.direction === "in" ? "+" : "−"}
                          {formatMoney(movement.amount)} บาท
                        </span>
                      </button>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Inline editor for one movement -- amount only, the same scope as
 *  Budget's ExpenseEditor, which never offers to rename the item either. */
function MovementEditor({
  movement,
  onSave,
  onCancel,
  onDelete,
}: {
  movement: SavingsMovement;
  onSave: (amount: number) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [amount, setAmount] = useState(String(movement.amount));

  return (
    <li className="space-y-2 py-3">
      <p className="text-sm">{movement.label}</p>
      <input
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        inputMode="decimal"
        aria-label="จำนวนเงิน"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-sm"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDelete}
          className="rounded-lg border border-red-900 px-3 py-2 text-sm text-red-400"
        >
          ลบ
        </button>
        <button type="button" onClick={onCancel} className="flex-1 rounded-lg bg-slate-800 py-2 text-sm">
          ยกเลิก
        </button>
        <button
          type="button"
          disabled={parseAmount(amount) === null || (parseAmount(amount) ?? 0) <= 0}
          onClick={() => onSave(parseAmount(amount) ?? 0)}
          className="flex-1 rounded-lg bg-sky-600 py-2 text-sm disabled:opacity-50"
        >
          บันทึก
        </button>
      </div>
    </li>
  );
}
