import { useMemo, useState } from "react";

interface Props {
  value: string | null;
  storeNames: string[];
  onChange: (name: string) => void;
}

/**
 * Picks which store a receipt belongs to from stores used before, or names
 * a new one.
 *
 * A free-text box let the same store get recorded under several spellings
 * ("Lotus's" / "โลตัส" / "Lotus"), which splits PriceHistory's store
 * grouping across names that are really the same place -- the same failure
 * mode MasterItemPicker exists to prevent for product names, so this
 * mirrors it rather than staying a plain <input>.
 */
export default function StorePicker({ value, storeNames, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? storeNames.filter((name) => name.toLowerCase().includes(needle))
      : storeNames;
    return matches.slice(0, 30);
  }, [storeNames, query]);

  function pick(name: string) {
    onChange(name);
    setOpen(false);
    setQuery("");
  }

  function createNew() {
    const name = newName.trim();
    if (!name) return;
    onChange(name);
    setNewName("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          // Seeded with what's already there, so opening the picker to
          // tweak a pre-filled name (e.g. a slip's suggested store) doesn't
          // throw away what's typed.
          setNewName(value ?? "");
        }}
        className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
          value
            ? "border-slate-700 bg-slate-900"
            : "border-amber-700 bg-slate-900 text-amber-300"
        }`}
      >
        {value || "แตะเพื่อเลือกร้าน"}
        <span className="float-right text-slate-500">▾</span>
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-sky-800 bg-slate-900 p-2">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="ค้นหาร้านที่มีอยู่"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
      />
      <ul className="max-h-48 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
        {filtered.length === 0 ? (
          <li className="px-3 py-2 text-xs text-slate-500">ไม่พบร้านที่ตรง</li>
        ) : (
          filtered.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => pick(name)}
                className="w-full px-3 py-2 text-left text-sm"
              >
                {name}
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="หรือตั้งชื่อร้านใหม่"
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={createNew}
          className="shrink-0 rounded-lg bg-sky-600 px-3 py-2 text-sm"
        >
          เพิ่ม
        </button>
      </div>

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-full py-1 text-xs text-slate-500"
      >
        ปิด
      </button>
    </div>
  );
}
