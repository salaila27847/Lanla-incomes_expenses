import { useEffect, useState } from "react";

type MustPayStatus = "unpaid" | "paid";

interface MustPayItem {
  id: string;
  name: string;
  amount: number;
  status: MustPayStatus;
  paidAt: string | null;
}

interface BudgetResponse {
  dailyBudget: { food: number; goods: number };
  spentToday: { food: number; goods: number };
  mustPay: MustPayItem[];
}

interface RecurringName {
  name: string;
  amount: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export default function Budget() {
  const [budget, setBudget] = useState<BudgetResponse | null>(null);
  const [recurringNames, setRecurringNames] = useState<RecurringName[]>([]);
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
      setBudget(await budgetRes.json());
      if (namesRes.ok) {
        const { names } = await namesRes.json();
        setRecurringNames(names);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
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
        <h2 className="text-base font-medium">งบประมาณรายวัน</h2>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-800 p-3">
            <p className="text-xs text-slate-500">🍔 ค่ากิน</p>
            <p className="text-lg">
              {(budget?.spentToday.food ?? 0).toLocaleString()} /{" "}
              {(budget?.dailyBudget.food ?? 5000).toLocaleString()} บาท
            </p>
          </div>
          <div className="rounded-lg border border-slate-800 p-3">
            <p className="text-xs text-slate-500">🧴 ของใช้</p>
            <p className="text-lg">
              {(budget?.spentToday.goods ?? 0).toLocaleString()} /{" "}
              {(budget?.dailyBudget.goods ?? 5000).toLocaleString()} บาท
            </p>
          </div>
        </div>
      </div>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      <div>
        <h2 className="text-base font-medium">รายการที่ต้องจ่าย</h2>
        {!budget || budget.mustPay.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ไม่มีรายการค้างจ่ายเดือนนี้</p>
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
    </section>
  );
}
