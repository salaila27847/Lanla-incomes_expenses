import { useEffect, useState } from "react";

interface PriceEntry {
  masterItemName: string;
  price: number;
  date: string;
}

interface PriceGroup {
  store: string;
  entries: PriceEntry[];
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export default function PriceHistory() {
  const [query, setQuery] = useState("");
  const [itemNames, setItemNames] = useState<string[]>([]);
  const [groups, setGroups] = useState<PriceGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE_URL}/prices/item-names`)
      .then((res) => (res.ok ? res.json() : { names: [] }))
      .then((data) => setItemNames(data.names ?? []))
      .catch(() => setItemNames([]));
  }, []);

  async function handleSearch(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/prices?item=${encodeURIComponent(query.trim())}`);
      if (!response.ok) {
        throw new Error(`ค้นหาไม่สำเร็จ (${response.status})`);
      }
      const result: { groups: PriceGroup[] } = await response.json();
      setGroups(result.groups);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
      setGroups(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">ประวัติราคา</h2>
        <p className="text-sm text-slate-400">ค้นหาชื่อสินค้าเพื่อดู Timeline ราคาตามร้าน</p>
      </div>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          list="price-history-item-names"
          placeholder="เช่น นมสด UHT"
          className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        />
        <datalist id="price-history-item-names">
          {itemNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <button
          type="submit"
          disabled={loading}
          className="shrink-0 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {loading ? "กำลังค้นหา..." : "ค้นหา"}
        </button>
      </form>

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      {groups === null ? (
        <p className="text-sm text-slate-500">พิมพ์ชื่อสินค้าแล้วกดค้นหา</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-500">ไม่มีประวัติราคาที่ตรงกัน</p>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.store}>
              <h3 className="text-sm font-medium text-slate-300">{group.store}</h3>
              <ul className="mt-1 space-y-1">
                {group.entries.map((entry, index) => (
                  <li
                    key={`${entry.date}-${index}`}
                    className="flex items-center justify-between rounded-lg border border-slate-800 px-3 py-2 text-sm"
                  >
                    <span>{entry.masterItemName}</span>
                    <span>{entry.price.toFixed(2)}</span>
                    <span className="text-slate-500">{entry.date}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
