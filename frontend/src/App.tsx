import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import ReceiptReview from "./pages/ReceiptReview";
import PriceHistory from "./pages/PriceHistory";
import Budget from "./pages/Budget";
import Dashboard from "./pages/Dashboard";
import SavingsQR from "./pages/SavingsQR";

// The dashboard leads, so it's also what opens on launch — a first tab that
// isn't the landing screen reads as a mistake.
const NAV_ITEMS = [
  { to: "/", icon: "📊", label: "ภาพรวม", end: true },
  { to: "/scan", icon: "📷", label: "รายจ่าย" },
  { to: "/budget", icon: "💰", label: "งบ" },
  { to: "/prices", icon: "🔍", label: "ราคา" },
  { to: "/savings", icon: "🐷", label: "เงินออม" },
];

export default function App() {
  // Every page is a single mobile column except the dashboard, whose table
  // is twelve pay-cycle columns wide and needs the room.
  const { pathname } = useLocation();
  const isWide = pathname === "/";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3">
        <h1 className="text-lg font-semibold">Smart Expense &amp; Price Tracker</h1>
      </header>

      <main className={`mx-auto p-4 pb-24 ${isWide ? "max-w-6xl" : "max-w-md"}`}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/scan" element={<ReceiptReview />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/prices" element={<PriceHistory />} />
          <Route path="/savings" element={<SavingsQR />} />
        </Routes>
      </main>

      {/* Tap targets are the whole point here: five text-only links at
          text-xs were too small to hit reliably. Each is now a full-height
          column of at least 56px, with the icon carrying recognition so the
          label can stay short. pb-safe keeps it clear of the iOS home bar. */}
      <nav className="fixed inset-x-0 bottom-0 flex border-t border-slate-800 bg-slate-950 pb-[env(safe-area-inset-bottom)]">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 ${
                isActive ? "text-sky-400" : "text-slate-400"
              }`
            }
          >
            <span aria-hidden className="text-lg leading-none">
              {item.icon}
            </span>
            <span className="text-[11px] leading-none">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
