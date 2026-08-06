import { useEffect, useState } from "react";

type MustPayStatus = "unpaid" | "paid";

interface MustPayItem {
  id: string;
  name: string;
  amount: number;
  status: MustPayStatus;
  paidAt: string | null;
}

interface Cycle {
  key: string;
  payday: string;
  end: string;
}

interface BudgetResponse {
  cycle: Cycle | null;
  cycleBudget: { food: number; goods: number };
  spentThisCycle: { food: number; goods: number };
  mustPay: MustPayItem[];
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
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export default function Budget() {
  const [budget, setBudget] = useState<BudgetResponse | null>(null);
  const [recurringNames, setRecurringNames] = useState<RecurringName[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
    const amount = Number(newAmount);
    if (!newName.trim() || !amount || amount <= 0) return;

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

  async function handleMarkPaid(id: string) {
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/budget/must-pay/${id}/mark-paid`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`บันทึกสถานะไม่สำเร็จ (${response.status})`);
      setBudget((prev) =>
        prev
          ? {
              ...prev,
              mustPay: prev.mustPay.map((item) =>
                item.id === id ? { ...item, status: "paid" as const } : item,
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
          <div className="rounded-lg border border-slate-800 p-3">
            <p className="text-xs text-slate-500">🍔 ค่ากิน</p>
            <p className="text-lg">
              {(budget?.spentThisCycle.food ?? 0).toLocaleString()} /{" "}
              {(budget?.cycleBudget.food ?? 5000).toLocaleString()} บาท
            </p>
          </div>
          <div className="rounded-lg border border-slate-800 p-3">
            <p className="text-xs text-slate-500">🧴 ของใช้</p>
            <p className="text-lg">
              {(budget?.spentThisCycle.goods ?? 0).toLocaleString()} /{" "}
              {(budget?.cycleBudget.goods ?? 5000).toLocaleString()} บาท
            </p>
          </div>
        </div>
      </div>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      <div>
        <h2 className="text-base font-medium">รายการที่ต้องจ่าย</h2>
        {!budget || budget.mustPay.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ไม่มีรายการค้างจ่ายรอบนี้</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {budget.mustPay.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2 text-sm">
                <span>{item.name}</span>
                <span>{item.amount.toLocaleString()} บาท</span>
                {item.status === "paid" ? (
                  <span>🟢 จ่ายแล้ว</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleMarkPaid(item.id)}
                    className="rounded-full bg-slate-800 px-3 py-1"
                  >
                    จ่ายแล้ว
                  </button>
                )}
              </li>
            ))}
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
        <h2 className="text-base font-medium">รายการซื้อของรอบนี้</h2>
        <p className="text-xs text-slate-500">
          แตะที่รายการเพื่อแก้ไข — สลิปที่สแกนมาผิดแก้ตรงนี้ได้เลย
        </p>
        {expenses.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ยังไม่มีรายการในรอบนี้</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {expenses.map((expense) =>
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
                      {(expense.price * expense.quantity).toLocaleString()} บาท
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </section>
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
          onClick={() => onSave({ price: Number(price) || 0, quantity, category })}
          className="flex-1 rounded-lg bg-sky-600 py-2 text-sm"
        >
          บันทึก
        </button>
      </div>
    </li>
  );
}
