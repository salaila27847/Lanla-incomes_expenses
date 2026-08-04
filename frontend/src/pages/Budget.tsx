interface MustPayItem {
  id: string;
  name: string;
  amount: number;
  paid: boolean;
}

const DAILY_BUDGET_THB = { food: 5000, goods: 5000 };

// TODO: replace with GET /budget on the controller (reads Google Sheets)
const MUST_PAY_ITEMS: MustPayItem[] = [];

export default function Budget() {
  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-medium">งบประมาณรายวัน</h2>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-800 p-3">
            <p className="text-xs text-slate-500">🍔 ค่ากิน</p>
            <p className="text-lg">{DAILY_BUDGET_THB.food.toLocaleString()} บาท</p>
          </div>
          <div className="rounded-lg border border-slate-800 p-3">
            <p className="text-xs text-slate-500">🧴 ของใช้</p>
            <p className="text-lg">{DAILY_BUDGET_THB.goods.toLocaleString()} บาท</p>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-base font-medium">รายการที่ต้องจ่าย</h2>
        {MUST_PAY_ITEMS.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">ไม่มีรายการค้างจ่าย</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {MUST_PAY_ITEMS.map((item) => (
              <li key={item.id} className="flex items-center justify-between py-2 text-sm">
                <span>{item.name}</span>
                <span>{item.amount.toLocaleString()} บาท</span>
                <span>{item.paid ? "🟢 จ่ายแล้ว" : "⚪️ รอจ่าย"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
