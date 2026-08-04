import { useState } from "react";

interface PricePoint {
  id: string;
  store: string;
  price: number;
  purchasedAt: string;
}

export default function PriceHistory() {
  const [query, setQuery] = useState("");
  // TODO: replace with GET /prices?item=... on the controller (reads Google Sheets)
  const [results] = useState<PricePoint[]>([]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">ประวัติราคา</h2>
        <p className="text-sm text-slate-400">ค้นหาชื่อสินค้าเพื่อดู Timeline ราคาตามร้าน</p>
      </div>

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="เช่น นมสด UHT"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />

      {results.length === 0 ? (
        <p className="text-sm text-slate-500">ไม่มีประวัติราคาที่ตรงกัน</p>
      ) : (
        <ul className="space-y-2">
          {results.map((point) => (
            <li
              key={point.id}
              className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2 text-sm"
            >
              <span>{point.store}</span>
              <span>{point.price.toFixed(2)}</span>
              <span className="text-slate-500">{point.purchasedAt}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
