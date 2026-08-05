import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import ReceiptReview from "./pages/ReceiptReview";
import PriceHistory from "./pages/PriceHistory";
import Budget from "./pages/Budget";
import Dashboard from "./pages/Dashboard";
import SavingsQR from "./pages/SavingsQR";

const NAV_ITEMS = [
  { to: "/", label: "สแกนสลิป", end: true },
  { to: "/prices", label: "ประวัติราคา" },
  { to: "/budget", label: "งบประมาณ" },
  { to: "/dashboard", label: "แดชบอร์ด" },
  { to: "/savings", label: "เงินออม" },
];

export default function App() {
  // Every page is a single mobile column except the dashboard, whose table
  // is twelve pay-cycle columns wide and needs the room.
  const isWide = useLocation().pathname.startsWith("/dashboard");

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3">
        <h1 className="text-lg font-semibold">Smart Expense &amp; Price Tracker</h1>
      </header>

      <main className={`mx-auto p-4 pb-20 ${isWide ? "max-w-6xl" : "max-w-md"}`}>
        <Routes>
          <Route path="/" element={<ReceiptReview />} />
          <Route path="/prices" element={<PriceHistory />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/savings" element={<SavingsQR />} />
        </Routes>
      </main>

      <nav className="fixed inset-x-0 bottom-0 flex justify-around border-t border-slate-800 bg-slate-950 py-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `px-2 py-1 text-xs ${isActive ? "text-sky-400" : "text-slate-400"}`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
