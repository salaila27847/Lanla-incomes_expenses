import { useState } from "react";

type ReceiptCategory = "food" | "goods";

interface ReceiptLineItem {
  id: string;
  rawText: string;
  masterItemName: string;
  category: ReceiptCategory;
  price: number;
}

// TODO: replace with items returned by POST /receipt on the controller
// (which itself calls the Python backend's /ocr and /match endpoints).
const PLACEHOLDER_ITEMS: ReceiptLineItem[] = [];

export default function ReceiptReview() {
  const [items, setItems] = useState<ReceiptLineItem[]>(PLACEHOLDER_ITEMS);

  function toggleCategory(id: string) {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? { ...item, category: item.category === "food" ? "goods" : "food" }
          : item,
      ),
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">สแกนสลิป</h2>
        <p className="text-sm text-slate-400">
          ถ่ายรูปสลิปเพื่อแยกรายการ [🍔 กิน] / [🧴 ใช้] และจับคู่ชื่อสินค้ามาตรฐาน
        </p>
      </div>

      {/* TODO: wire up file input / camera capture -> upload to controller's POST /receipt */}
      <button
        type="button"
        className="w-full rounded-lg border border-dashed border-slate-700 py-6 text-sm text-slate-400"
      >
        แตะเพื่อถ่ายรูปสลิป
      </button>

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">ยังไม่มีรายการให้ตรวจสอบ</p>
      ) : (
        <ul className="divide-y divide-slate-800">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between py-3">
              <div>
                {/* TODO: Search Dropdown Auto-complete to change masterItemName in 1 tap */}
                <p className="text-sm">{item.masterItemName}</p>
                <p className="text-xs text-slate-500">{item.rawText}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm">{item.price.toFixed(2)}</span>
                <button
                  type="button"
                  onClick={() => toggleCategory(item.id)}
                  className="rounded-full bg-slate-800 px-3 py-1 text-sm"
                >
                  {item.category === "food" ? "🍔 กิน" : "🧴 ใช้"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
