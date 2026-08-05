import { useEffect, useState } from "react";

interface CycleColumn {
  key: string;
  payday: string;
  end: string;
}

interface DashboardRow {
  name: string;
  amounts: Record<string, number>;
}

interface DashboardSection {
  id: string;
  title: string;
  rows: DashboardRow[];
}

interface DashboardResponse {
  year: number;
  cycles: CycleColumn[];
  currentCycleKey: string | null;
  sections: DashboardSection[];
  totals: {
    income: Record<string, number>;
    expense: Record<string, number>;
    net: Record<string, number>;
    spendingBalance: Record<string, number>;
    savingsBalance: Record<string, number | null>;
  };
  budget: { food: number; goods: number };
  settings: { openingBalance: number; cycleBudgetFood: number; cycleBudgetGoods: number };
}

interface CycleSetting extends CycleColumn {
  savingsBalance: number | null;
  paydayIsRecorded: boolean;
}

interface IncomeSource {
  source: string;
  amount: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

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

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function monthLabel(cycleKey: string): string {
  return THAI_MONTHS[Number(cycleKey.slice(5, 7)) - 1];
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${THAI_MONTHS[month - 1]}`;
}

function money(value: number): string {
  return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Expenses read as negatives in the user's own spreadsheet: (1,234.00). */
function signed(value: number): string {
  return value < 0 ? `(${money(-value)})` : money(value);
}

/**
 * The dates that can open a given cycle.
 *
 * A cycle is named for the month whose 15th it contains, so its payday is
 * either the 1st–15th of that month or the 16th onwards of the one before —
 * a single contiguous window. Feeding it to the date picker's min/max means
 * the user can't pick a date the API would reject.
 */
function paydayWindow(cycleKey: string): { min: string; max: string } {
  const [year, month] = cycleKey.split("-").map(Number);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return {
    min: `${previous.year}-${pad(previous.month)}-16`,
    max: `${year}-${pad(month)}-15`,
  };
}

const CELL = "whitespace-nowrap px-3 py-2";
const STICKY = "sticky left-0 z-10 border-r border-slate-800 bg-slate-950 text-left";

export default function Dashboard() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [openPanel, setOpenPanel] = useState<"income" | "cycles" | null>(null);

  async function loadDashboard(forYear: number) {
    try {
      const response = await fetch(`${API_BASE_URL}/dashboard?year=${forYear}`);
      if (!response.ok) throw new Error(`โหลดแดชบอร์ดไม่สำเร็จ (${response.status})`);
      setData(await response.json());
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    }
  }

  useEffect(() => {
    loadDashboard(year);
  }, [year]);

  const cycles = data?.cycles ?? [];
  const current = data?.currentCycleKey ?? null;

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-medium">แดชบอร์ดรายปี</h2>
        <div className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => setYear((value) => value - 1)}
            className="rounded-full bg-slate-800 px-3 py-1"
          >
            ←
          </button>
          <span className="w-12 text-center tabular-nums">{year}</span>
          <button
            type="button"
            onClick={() => setYear((value) => value + 1)}
            className="rounded-full bg-slate-800 px-3 py-1"
          >
            →
          </button>
        </div>
      </header>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      {data && current && <CurrentCycleCards data={data} cycleKey={current} />}

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full min-w-max border-collapse text-right text-xs">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              <th className={`${CELL} ${STICKY} bg-slate-900 font-medium`}>รายการ</th>
              {cycles.map((cycle) => (
                <th
                  key={cycle.key}
                  className={`${CELL} font-medium ${
                    cycle.key === current ? "text-sky-400" : "text-slate-300"
                  }`}
                >
                  <div>{monthLabel(cycle.key)}</div>
                  <div className="text-[10px] font-normal text-slate-500">
                    {shortDate(cycle.payday)}–{shortDate(cycle.end)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {data?.sections.map((section) => (
              <SectionRows key={section.id} section={section} cycles={cycles} />
            ))}

            {data && (
              <>
                <tr className="bg-slate-900/60">
                  <td className={`${CELL} ${STICKY} bg-slate-900 font-medium text-sky-400`} colSpan={1}>
                    สรุป
                  </td>
                  {cycles.map((cycle) => (
                    <td key={cycle.key} className={`${CELL} bg-slate-900/60`} />
                  ))}
                </tr>
                <TotalRow
                  label="รวมรายรับ"
                  amounts={data.totals.income}
                  cycles={cycles}
                  className="text-emerald-400"
                />
                <TotalRow
                  label="รวมรายจ่าย"
                  amounts={data.totals.expense}
                  cycles={cycles}
                  className="text-red-400"
                />
                <TotalRow
                  label="คงเหลือสุทธิ"
                  amounts={data.totals.net}
                  cycles={cycles}
                  colorBySign
                />
                <TotalRow
                  label="บัญชีใช้จ่าย (คำนวณ)"
                  amounts={data.totals.spendingBalance}
                  cycles={cycles}
                  colorBySign
                />
                <TotalRow
                  label="บัญชีเงินออม (กรอกเอง)"
                  amounts={data.totals.savingsBalance}
                  cycles={cycles}
                />
              </>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setOpenPanel(openPanel === "income" ? null : "income")}
          className="flex-1 rounded-lg bg-slate-800 py-2 text-sm"
        >
          ＋ รายรับ
        </button>
        <button
          type="button"
          onClick={() => setOpenPanel(openPanel === "cycles" ? null : "cycles")}
          className="flex-1 rounded-lg bg-slate-800 py-2 text-sm"
        >
          ⚙ ตั้งค่ารอบเงินเดือน
        </button>
      </div>

      {openPanel === "income" && <IncomePanel onSaved={() => loadDashboard(year)} />}
      {openPanel === "cycles" && data && (
        <CyclePanel year={year} settings={data.settings} onSaved={() => loadDashboard(year)} />
      )}
    </section>
  );
}

function CurrentCycleCards({ data, cycleKey }: { data: DashboardResponse; cycleKey: string }) {
  const cycle = data.cycles.find((entry) => entry.key === cycleKey);
  const variable = data.sections.find((section) => section.id === "variable");
  const food = variable?.rows.find((row) => row.name.includes("ค่ากิน"))?.amounts[cycleKey] ?? 0;
  const goods = variable?.rows.find((row) => row.name.includes("ของใช้"))?.amounts[cycleKey] ?? 0;
  const fixed = data.sections
    .find((section) => section.id === "fixed")
    ?.rows.reduce((sum, row) => sum + (row.amounts[cycleKey] ?? 0), 0);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Card
        label={`รายรับรอบนี้${cycle ? ` (${shortDate(cycle.payday)}–${shortDate(cycle.end)})` : ""}`}
        value={money(data.totals.income[cycleKey] ?? 0)}
        className="text-emerald-400"
      />
      <Card label="รายจ่ายคงที่ / บิล" value={money(fixed ?? 0)} className="text-red-400" />
      <Card
        label="ค่ากิน + ของใช้"
        value={`${money(food + goods)}`}
        hint={`งบ ${money(data.budget.food + data.budget.goods)} ต่อรอบ`}
        className={food + goods > data.budget.food + data.budget.goods ? "text-red-400" : "text-sky-400"}
      />
      <Card
        label="ยอดบัญชีใช้จ่าย (คำนวณ)"
        value={signed(data.totals.spendingBalance[cycleKey] ?? 0)}
        hint="ยอดตั้งต้น + รายรับ − รายจ่าย"
      />
    </div>
  );
}

function Card({
  label,
  value,
  hint,
  className = "",
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-800 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-lg tabular-nums ${className}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

function SectionRows({ section, cycles }: { section: DashboardSection; cycles: CycleColumn[] }) {
  if (section.rows.length === 0) return null;

  return (
    <>
      <tr className="bg-slate-900/60">
        <td className={`${CELL} ${STICKY} bg-slate-900 font-medium text-sky-400`}>{section.title}</td>
        {cycles.map((cycle) => (
          <td key={cycle.key} className={`${CELL} bg-slate-900/60`} />
        ))}
      </tr>
      {section.rows.map((row) => (
        <tr key={row.name} className="border-b border-slate-900">
          <td className={`${CELL} ${STICKY}`}>{row.name}</td>
          {cycles.map((cycle) => (
            <td key={cycle.key} className={`${CELL} tabular-nums text-slate-300`}>
              {row.amounts[cycle.key] ? money(row.amounts[cycle.key]) : "–"}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function TotalRow({
  label,
  amounts,
  cycles,
  className = "",
  colorBySign = false,
}: {
  label: string;
  amounts: Record<string, number | null>;
  cycles: CycleColumn[];
  className?: string;
  colorBySign?: boolean;
}) {
  return (
    <tr className="border-b border-slate-900 font-medium">
      <td className={`${CELL} ${STICKY}`}>{label}</td>
      {cycles.map((cycle) => {
        const value = amounts[cycle.key];
        const tone = colorBySign && value !== null ? (value < 0 ? "text-red-400" : "text-emerald-400") : className;
        return (
          <td key={cycle.key} className={`${CELL} tabular-nums ${tone}`}>
            {value === null || value === undefined ? "–" : signed(value)}
          </td>
        );
      })}
    </tr>
  );
}

function IncomePanel({ onSaved }: { onSaved: () => void }) {
  const [sources, setSources] = useState<IncomeSource[]>([]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/income/sources`)
      .then((response) => (response.ok ? response.json() : { sources: [] }))
      .then((body) => setSources(body.sources))
      .catch(() => setSources([]));
  }, []);

  function handleSourceChange(value: string) {
    setSource(value);
    // Picking a source used before pre-fills its last amount, same as the
    // must-pay form on the Budget page.
    const existing = sources.find((entry) => entry.source === value);
    if (existing) setAmount(String(existing.amount));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const value = Number(amount);
    if (!source.trim() || !value || value <= 0) return;

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/income`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, source: source.trim(), amount: value }),
      });
      if (!response.ok) throw new Error(`บันทึกรายรับไม่สำเร็จ (${response.status})`);
      setSource("");
      setAmount("");
      onSaved();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 rounded-lg border border-slate-800 p-3">
      <h3 className="text-sm font-medium">เพิ่มรายรับ</h3>
      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}
      <input
        type="date"
        value={date}
        onChange={(event) => setDate(event.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />
      <input
        value={source}
        onChange={(event) => handleSourceChange(event.target.value)}
        list="income-sources"
        placeholder="แหล่งที่มา เช่น เงินเดือน"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />
      <datalist id="income-sources">
        {sources.map((entry) => (
          <option key={entry.source} value={entry.source} />
        ))}
      </datalist>
      <input
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        inputMode="decimal"
        placeholder="จำนวนเงิน (บาท)"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium disabled:opacity-50"
      >
        {submitting ? "กำลังบันทึก..." : "บันทึกรายรับ"}
      </button>
    </form>
  );
}

function CyclePanel({
  year,
  settings,
  onSaved,
}: {
  year: number;
  settings: DashboardResponse["settings"];
  onSaved: () => void;
}) {
  const [cycles, setCycles] = useState<CycleSetting[]>([]);
  const [openingBalance, setOpeningBalance] = useState(String(settings.openingBalance));
  const [budgetFood, setBudgetFood] = useState(String(settings.cycleBudgetFood));
  const [budgetGoods, setBudgetGoods] = useState(String(settings.cycleBudgetGoods));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadCycles() {
    const response = await fetch(`${API_BASE_URL}/dashboard/cycles?year=${year}`);
    if (response.ok) setCycles((await response.json()).cycles);
  }

  useEffect(() => {
    loadCycles();
  }, [year]);

  async function saveCycle(key: string, patch: { payday?: string; savingsBalance?: number | null }) {
    setErrorMessage(null);
    const response = await fetch(`${API_BASE_URL}/dashboard/cycles/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setErrorMessage(body.error ?? `บันทึกไม่สำเร็จ (${response.status})`);
      return;
    }
    await loadCycles();
    onSaved();
  }

  async function saveSettings() {
    setErrorMessage(null);
    const response = await fetch(`${API_BASE_URL}/dashboard/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openingBalance: Number(openingBalance),
        cycleBudgetFood: Number(budgetFood),
        cycleBudgetGoods: Number(budgetGoods),
      }),
    });
    if (!response.ok) {
      setErrorMessage(`บันทึกการตั้งค่าไม่สำเร็จ (${response.status})`);
      return;
    }
    onSaved();
  }

  return (
    <div className="space-y-4 rounded-lg border border-slate-800 p-3">
      <div>
        <h3 className="text-sm font-medium">วันเงินเดือนเข้า ปี {year}</h3>
        <p className="mt-1 text-xs text-slate-500">
          รอบเดือนนับจากวันเงินเดือนเข้า ถึงวันก่อนเงินเดือนรอบถัดไป เดือนที่ยังไม่ได้กรอกจะเดาให้จาก
          รอบที่ใกล้ที่สุด (แสดงเป็นสีจาง)
        </p>
      </div>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      <ul className="space-y-2">
        {cycles.map((cycle) => {
          const window = paydayWindow(cycle.key);
          return (
            <li key={cycle.key} className="flex items-center gap-2 text-sm">
              <span
                className={`w-12 shrink-0 ${cycle.paydayIsRecorded ? "text-slate-200" : "text-slate-600"}`}
              >
                {monthLabel(cycle.key)}
              </span>
              <input
                type="date"
                value={cycle.payday}
                min={window.min}
                max={window.max}
                onChange={(event) => saveCycle(cycle.key, { payday: event.target.value })}
                className={`min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs ${
                  cycle.paydayIsRecorded ? "" : "text-slate-500"
                }`}
              />
              <input
                defaultValue={cycle.savingsBalance ?? ""}
                inputMode="decimal"
                placeholder="เงินออม"
                onBlur={(event) =>
                  saveCycle(cycle.key, {
                    savingsBalance: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
                className="w-24 shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-right text-xs"
              />
            </li>
          );
        })}
      </ul>

      <div className="space-y-2 border-t border-slate-800 pt-3">
        <h3 className="text-sm font-medium">ตั้งค่างบ</h3>
        <LabelledInput
          label="ยอดตั้งต้นบัญชีใช้จ่าย"
          value={openingBalance}
          onChange={setOpeningBalance}
        />
        <LabelledInput label="งบค่ากิน ต่อรอบ" value={budgetFood} onChange={setBudgetFood} />
        <LabelledInput label="งบของใช้ ต่อรอบ" value={budgetGoods} onChange={setBudgetGoods} />
        <button
          type="button"
          onClick={saveSettings}
          className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium"
        >
          บันทึกการตั้งค่า
        </button>
      </div>
    </div>
  );
}

function LabelledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      <span className="text-slate-400">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        className="w-32 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-right text-sm"
      />
    </label>
  );
}
