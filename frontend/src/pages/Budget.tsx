import { useEffect, useState } from "react";
import { formatMoney, parseAmount } from "../money";

type MustPayStatus = "unpaid" | "paid";

interface MustPayItem {
  id: string;
  name: string;
  amount: number;
  status: MustPayStatus;
  paidAt: string | null;
  /** Set when this row was generated from a RecurringBill (or a shared
   *  card group) rather than typed in by hand. */
  recurringGroupKey: string | null;
}

interface Cycle {
  key: string;
  payday: string;
  end: string;
}

interface RecurringBill {
  id: string;
  name: string;
  amount: number;
  cardGroup: string | null;
  /** null = no end date, recurs forever (rent, utilities). A number counts
   *  down each cycle it generates a row and stops on its own at zero. */
  installmentsRemaining: number | null;
  active: boolean;
}

interface BudgetResponse {
  cycle: Cycle | null;
  cycleBudget: { food: number; goods: number };
  spentThisCycle: { food: number; goods: number };
  mustPay: MustPayItem[];
  recurringBills: RecurringBill[];
}

const THAI_MONTHS = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${THAI_MONTHS[month - 1]}`;
}

interface RecurringName {
  name: string;
  amount: number;
}

interface Expense {
  id: string;
  date: string;
  store: string | null;
  masterItemName: string;
  category: "food" | "goods";
  price: number;
  quantity: number;
  discount: number;
}

interface ExpenseDateGroup {
  date: string;
  items: Expense[];
}

/** Buckets an already-sorted expense list into consecutive same-date runs.
 *  Relies on the caller's ordering rather than re-sorting -- `/expenses`
 *  already returns newest date first, so grouping preserves that. */
export function groupExpensesByDate(expenses: Expense[]): ExpenseDateGroup[] {
  const groups: ExpenseDateGroup[] = [];
  for (const expense of expenses) {
    const current = groups[groups.length - 1];
    if (current && current.date === expense.date) current.items.push(expense);
    else groups.push({ date: expense.date, items: [expense] });
  }
  return groups;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export default function Budget() {
  const [budget, setBudget] = useState<BudgetResponse | null>(null);
  const [recurringNames, setRecurringNames] = useState<RecurringName[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const [confirmingStopId, setConfirmingStopId] = useState<string | null>(null);
  const [recurringName, setRecurringName] = useState("");
  const [recurringAmount, setRecurringAmount] = useState("");
  const [recurringInstallments, setRecurringInstallments] = useState("");
  const [recurringCardGroup, setRecurringCardGroup] = useState("");
  const [submittingRecurring, setSubmittingRecurring] = useState(false);

  async function loadBudget() {
    try {
      const [budgetRes, namesRes] = await Promise.all([
        fetch(`${API_BASE_URL}/budget`),
        fetch(`${API_BASE_URL}/budget/must-pay/recurring-names`),
      ]);
      if (!budgetRes.ok) throw new Error(`โหลดงบประมาณไม่สำเร็จ (${budgetRes.status})`);
      const loaded: BudgetResponse = await budgetRes.json();
      setBudget(loaded);
      if (namesRes.ok) {
        const { names } = await namesRes.json();
        setRecurringNames(names);
      }
      if (loaded.cycle) await loadExpenses(loaded.cycle.key);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  async function loadExpenses(cycleKey: string) {
    const response = await fetch(`${API_BASE_URL}/expenses?cycle=${cycleKey}`);
    if (response.ok) setExpenses((await response.json()).expenses);
  }

  async function saveExpense(id: string, patch: Partial<Expense>) {
    setErrorMessage(null);
    const response = await fetch(`${API_BASE_URL}/expenses/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrorMessage(body.error ?? `แก้ไขไม่สำเร็จ (${response.status})`);
      return;
    }
    setEditingId(null);
    await loadBudget();
  }

  async function deleteExpense(id: string) {
    setErrorMessage(null);
    const response = await fetch(`${API_BASE_URL}/expenses/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setErrorMessage(`ลบไม่สำเร็จ (${response.status})`);
      return;
    }
    await loadBudget();
  }

  useEffect(() => {
    loadBudget();
  }, []);

  function handleNameChange(name: string) {
    setNewName(name);
    // Picking a name that's been used before pre-fills its last amount.
    const existing = recurringNames.find((item) => item.name === name);
    if (existing) setNewAmount(String(existing.amount));
  }

  async function handleAddMustPay(event: React.FormEvent) {
    event.preventDefault();
    const amount = parseAmount(newAmount);
    if (!newName.trim() || amount === null || amount <= 0) return;

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/budget/must-pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), amount }),
      });
      if (!response.ok) throw new Error(`เพิ่มรายการไม่สำเร็จ (${response.status})`);
      setNewName("");
      setNewAmount("");
      await loadBudget();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteMustPay(id: string) {
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/budget/must-pay/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`ลบรายการไม่สำเร็จ (${response.status})`);
      setConfirmingDeleteId(null);
      await loadBudget();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  async function handleAddRecurring(event: React.FormEvent) {
    event.preventDefault();
    const amount = parseAmount(recurringAmount);
    if (!recurringName.trim() || amount === null || amount <= 0) return;

    const installmentsText = recurringInstallments.trim();
    const installments = installmentsText ? Number(installmentsText) : undefined;
    if (installmentsText && (!Number.isInteger(installments) || (installments as number) <= 0)) {
      setErrorMessage("จำนวนงวดต้องเป็นเลขจำนวนเต็มบวก หรือเว้นว่างถ้าไม่มีกำหนด");
      return;
    }

    setSubmittingRecurring(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/budget/recurring`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: recurringName.trim(),
          amount,
          cardGroup: recurringCardGroup.trim() || undefined,
          installments,
        }),
      });
      if (!response.ok) throw new Error(`เพิ่มบิลประจำไม่สำเร็จ (${response.status})`);
      setRecurringName("");
      setRecurringAmount("");
      setRecurringInstallments("");
      setRecurringCardGroup("");
      await loadBudget();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    } finally {
      setSubmittingRecurring(false);
    }
  }

  async function handleStopRecurring(id: string) {
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/budget/recurring/${encodeURIComponent(id)}/stop`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`หยุดบิลประจำไม่สำเร็จ (${response.status})`);
      setConfirmingStopId(null);
      await loadBudget();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  async function handleSetPaid(id: string, paid: boolean) {
    setErrorMessage(null);
    const status = paid ? "paid" : "unpaid";
    try {
      const response = await fetch(
        `${API_BASE_URL}/budget/must-pay/${encodeURIComponent(id)}/mark-${status}`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`บันทึกสถานะไม่สำเร็จ (${response.status})`);
      setBudget((prev) =>
        prev
          ? {
              ...prev,
              mustPay: prev.mustPay.map((item) =>
                item.id === id ? { ...item, status } : item,
              ),
            }
          : prev,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-medium">งบประมาณรอบนี้</h2>
        <p className="text-xs text-slate-500">
          {budget?.cycle
            ? `${shortDate(budget.cycle.payday)} – ${shortDate(budget.cycle.end)} (นับจากวันเงินเดือนเข้า)`
            : "กำลังโหลด..."}
        </p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <BudgetCard
            label="🍔 ค่ากิน"
            spent={budget?.spentThisCycle.food ?? 0}
            cap={budget?.cycleBudget.food ?? 5000}
          />
          <BudgetCard
            label="🧴 ของใช้"
            spent={budget?.spentThisCycle.goods ?? 0}
            cap={budget?.cycleBudget.goods ?? 5000}
          />
        </div>
      </div>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      <div>
        <h2 className="text-base font-medium">รายการที่ต้องจ่าย</h2>
        {!budget || budget.mustPay.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ไม่มีรายการค้างจ่ายรอบนี้</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {budget.mustPay.map((item) =>
              confirmingDeleteId === item.id ? (
                <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-slate-400">
                    ลบ “{item.name}”?
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteId(null)}
                    className="shrink-0 rounded-full bg-slate-800 px-3 py-1.5"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteMustPay(item.id)}
                    className="shrink-0 rounded-full bg-red-700 px-3 py-1.5"
                  >
                    ลบ
                  </button>
                </li>
              ) : (
                <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {item.recurringGroupKey && <span title="สร้างจากบิลประจำ">🔁 </span>}
                    {item.name}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatMoney(item.amount)} บาท
                  </span>
                  {/* Tapping it again undoes it — the button sits in a
                      crowded row and a mistap used to be unrecoverable
                      without deleting the bill and retyping it. */}
                  <button
                    type="button"
                    onClick={() => handleSetPaid(item.id, item.status !== "paid")}
                    title={item.status === "paid" ? "แตะเพื่อยกเลิก" : undefined}
                    className={`shrink-0 rounded-full px-3 py-1.5 ${
                      item.status === "paid" ? "bg-emerald-900/60" : "bg-slate-800"
                    }`}
                  >
                    {item.status === "paid" ? "🟢 จ่ายแล้ว" : "จ่ายแล้ว"}
                  </button>
                  {/* Two taps to delete: the list is typed in by hand, so a
                      stray tap on a crowded row shouldn't lose a bill. */}
                  <button
                    type="button"
                    onClick={() => setConfirmingDeleteId(item.id)}
                    aria-label={`ลบ ${item.name}`}
                    className="shrink-0 px-2 py-1.5 text-slate-500"
                  >
                    ✕
                  </button>
                </li>
              ),
            )}
          </ul>
        )}

        <form onSubmit={handleAddMustPay} className="mt-3 space-y-2">
          <input
            value={newName}
            onChange={(event) => handleNameChange(event.target.value)}
            list="must-pay-names"
            placeholder="ชื่อรายการ เช่น ค่าไฟ"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
          />
          <datalist id="must-pay-names">
            {recurringNames.map((item) => (
              <option key={item.name} value={item.name} />
            ))}
          </datalist>
          <input
            value={newAmount}
            onChange={(event) => setNewAmount(event.target.value)}
            inputMode="decimal"
            placeholder="จำนวนเงิน (บาท)"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium disabled:opacity-50"
          >
            {submitting ? "กำลังเพิ่ม..." : "เพิ่มรายการ"}
          </button>
        </form>
      </div>

      <div>
        <h2 className="text-base font-medium">บิลประจำ</h2>
        <p className="text-xs text-slate-500">
          สร้างรายการที่ต้องจ่ายให้อัตโนมัติทุกรอบ — บิลที่ผ่านบัตรเดียวกันจะรวมยอดเป็นรายการเดียว
        </p>

        {!budget || budget.recurringBills.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ยังไม่มีบิลประจำ</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {budget.recurringBills.map((bill) =>
              confirmingStopId === bill.id ? (
                <li key={bill.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-slate-400">
                    หยุด “{bill.name}”? รายการรอบก่อนหน้ายังอยู่เหมือนเดิม
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmingStopId(null)}
                    className="shrink-0 rounded-full bg-slate-800 px-3 py-1.5"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={() => handleStopRecurring(bill.id)}
                    className="shrink-0 rounded-full bg-red-700 px-3 py-1.5"
                  >
                    หยุด
                  </button>
                </li>
              ) : (
                <li key={bill.id} className="space-y-0.5 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate">{bill.name}</span>
                    <span className="shrink-0 tabular-nums">{formatMoney(bill.amount)} บาท</span>
                    <button
                      type="button"
                      onClick={() => setConfirmingStopId(bill.id)}
                      className="shrink-0 px-2 py-1 text-xs text-slate-500"
                    >
                      หยุด
                    </button>
                  </div>
                  <p className="text-xs text-slate-500">
                    {bill.cardGroup && `ผ่านบัตร: ${bill.cardGroup} · `}
                    {bill.installmentsRemaining === null
                      ? "ไม่มีกำหนด"
                      : `เหลืออีก ${bill.installmentsRemaining} งวด`}
                  </p>
                </li>
              ),
            )}
          </ul>
        )}

        <form onSubmit={handleAddRecurring} className="mt-3 space-y-2">
          <input
            value={recurringName}
            onChange={(event) => setRecurringName(event.target.value)}
            placeholder="ชื่อรายการ เช่น ผ่อนโทรศัพท์"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
          />
          <input
            value={recurringAmount}
            onChange={(event) => setRecurringAmount(event.target.value)}
            inputMode="decimal"
            placeholder="จำนวนเงินต่องวด (บาท)"
            className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={recurringInstallments}
              onChange={(event) => setRecurringInstallments(event.target.value)}
              inputMode="numeric"
              placeholder="จำนวนงวด (ว่าง = ไม่มีกำหนด)"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
            <input
              value={recurringCardGroup}
              onChange={(event) => setRecurringCardGroup(event.target.value)}
              list="recurring-card-groups"
              placeholder="ผ่านบัตร (ถ้ามี)"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
            <datalist id="recurring-card-groups">
              {Array.from(new Set((budget?.recurringBills ?? []).map((bill) => bill.cardGroup).filter(Boolean))).map(
                (cardGroup) => (
                  <option key={cardGroup} value={cardGroup ?? ""} />
                ),
              )}
            </datalist>
          </div>
          <button
            type="submit"
            disabled={submittingRecurring}
            className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium disabled:opacity-50"
          >
            {submittingRecurring ? "กำลังเพิ่ม..." : "เพิ่มบิลประจำ"}
          </button>
        </form>
      </div>

      <div>
        <h2 className="text-base font-medium">รายการซื้อของรอบนี้</h2>
        <p className="text-xs text-slate-500">
          แตะที่รายการเพื่อแก้ไข — สลิปที่สแกนมาผิดแก้ตรงนี้ได้เลย
        </p>
        {expenses.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ยังไม่มีรายการในรอบนี้</p>
        ) : (
          <div className="mt-2">
            {groupExpensesByDate(expenses).map((group, index) => (
              <div key={group.date} className={index > 0 ? "mt-3" : ""}>
                <p className="text-xs font-medium text-slate-400">{shortDate(group.date)}</p>
                <ul className="mt-1 divide-y divide-slate-800">
                  {group.items.map((expense) =>
                    editingId === expense.id ? (
                      <ExpenseEditor
                        key={expense.id}
                        expense={expense}
                        onCancel={() => setEditingId(null)}
                        onSave={(patch) => saveExpense(expense.id, patch)}
                        onDelete={() => deleteExpense(expense.id)}
                      />
                    ) : (
                      <li key={expense.id}>
                        <button
                          type="button"
                          onClick={() => setEditingId(expense.id)}
                          className="flex w-full items-center justify-between gap-2 py-2 text-left text-sm"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {expense.category === "food" ? "🍔" : "🧴"} {expense.masterItemName}
                            {expense.quantity > 1 && (
                              <span className="text-slate-500"> ×{expense.quantity}</span>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {formatMoney(expense.price * expense.quantity - expense.discount)} บาท
                            {expense.discount > 0 && (
                              <span className="ml-1 text-xs text-emerald-400">
                                (ลด {formatMoney(expense.discount)})
                              </span>
                            )}
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
      </div>
    </section>
  );
}

/** One of the two cap cards — spent/cap plus how much of the cap is left,
 *  called out separately once it goes negative rather than just printing
 *  a minus sign next to "คงเหลือ". */
function BudgetCard({ label, spent, cap }: { label: string; spent: number; cap: number }) {
  const remaining = cap - spent;
  return (
    <div className="rounded-lg border border-slate-800 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg">
        {formatMoney(spent)} / {formatMoney(cap)} บาท
      </p>
      <p className={`text-xs ${remaining < 0 ? "text-red-400" : "text-slate-500"}`}>
        {remaining < 0
          ? `เกินงบ ${formatMoney(Math.abs(remaining))} บาท`
          : `คงเหลือ ${formatMoney(remaining)} บาท`}
      </p>
    </div>
  );
}

/** Inline editor for one already-saved expense row. */
function ExpenseEditor({
  expense,
  onSave,
  onCancel,
  onDelete,
}: {
  expense: Expense;
  onSave: (patch: Partial<Expense>) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [price, setPrice] = useState(String(expense.price));
  const [quantity, setQuantity] = useState(expense.quantity);
  const [discount, setDiscount] = useState(expense.discount ? String(expense.discount) : "");
  const [category, setCategory] = useState(expense.category);

  return (
    <li className="space-y-2 py-3">
      <p className="text-sm">{expense.masterItemName}</p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setCategory(category === "food" ? "goods" : "food")}
          className="shrink-0 rounded-full bg-slate-800 px-3 py-2 text-sm"
        >
          {category === "food" ? "🍔 กิน" : "🧴 ใช้"}
        </button>
        <div className="flex shrink-0 items-center rounded-full bg-slate-800">
          <button
            type="button"
            onClick={() => setQuantity(Math.max(1, quantity - 1))}
            className="px-3 py-2 text-sm"
            aria-label="ลดจำนวน"
          >
            −
          </button>
          <span className="min-w-6 text-center text-sm tabular-nums">{quantity}</span>
          <button
            type="button"
            onClick={() => setQuantity(quantity + 1)}
            className="px-3 py-2 text-sm"
            aria-label="เพิ่มจำนวน"
          >
            ＋
          </button>
        </div>
        <input
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          inputMode="decimal"
          aria-label="ราคาต่อชิ้น"
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-sm"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <label className="text-xs text-slate-500">ส่วนลด</label>
        <input
          value={discount}
          onChange={(event) => setDiscount(event.target.value)}
          inputMode="decimal"
          placeholder="0"
          aria-label="ส่วนลดของรายการนี้"
          className="w-24 rounded-lg border border-slate-800 bg-slate-900 px-2 py-1.5 text-right text-sm"
        />
      </div>
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
          disabled={parseAmount(price) === null || (discount !== "" && parseAmount(discount) === null)}
          onClick={() =>
            onSave({
              price: parseAmount(price) ?? 0,
              quantity,
              category,
              discount: discount === "" ? 0 : (parseAmount(discount) ?? 0),
            })
          }
          className="flex-1 rounded-lg bg-sky-600 py-2 text-sm disabled:opacity-50"
        >
          บันทึก
        </button>
      </div>
    </li>
  );
}
