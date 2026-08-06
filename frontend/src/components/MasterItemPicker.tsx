import { useMemo, useState } from "react";

export interface MasterItem {
  name: string;
  category: "food" | "goods";
}

export interface MatchCandidate {
  name: string;
  score: number;
}

interface Props {
  value: string;
  masterItems: MasterItem[];
  /** Ranked suggestions for this receipt line, shown first. Empty for
   *  manual entry, where there's no OCR text to match against. */
  candidates?: MatchCandidate[];
  /** Seeds the "create new" field — the receipt's raw text, usually. */
  suggestedNewName?: string;
  onChange: (name: string, category: "food" | "goods" | null) => void;
}

/**
 * Picks the standard product name a line belongs to.
 *
 * Every line gets one, including the ones the matcher was confident about.
 * The old screen printed a confident match as plain text with no way to
 * change it, which is how two brands of the same product quietly ended up
 * sharing a price history: receipts often don't print the brand at all, so
 * the matcher scores every brand identically and picks whichever came
 * first. Only the person who did the shopping knows.
 *
 * "Create new" exists for the other half of that problem — a second brand
 * needs to become its own master item rather than be filed under the first.
 */
export default function MasterItemPicker({
  value,
  masterItems,
  candidates = [],
  suggestedNewName = "",
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");

  const categoryOf = useMemo(
    () => new Map(masterItems.map((item) => [item.name, item.category])),
    [masterItems],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? masterItems.filter((item) => item.name.toLowerCase().includes(needle))
      : masterItems;
    return matches.slice(0, 30);
  }, [masterItems, query]);

  function pick(name: string) {
    onChange(name, categoryOf.get(name) ?? null);
    setOpen(false);
    setQuery("");
  }

  function createNew() {
    const name = newName.trim();
    if (!name) return;
    // No category on a brand-new name — the caller keeps whatever the
    // line already had rather than silently flipping it.
    onChange(name, null);
    setNewName("");
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setNewName(suggestedNewName);
        }}
        className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
          value
            ? "border-slate-700 bg-slate-900"
            : "border-amber-700 bg-slate-900 text-amber-300"
        }`}
      >
        {value || "แตะเพื่อเลือกสินค้า"}
        <span className="float-right text-slate-500">▾</span>
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-sky-800 bg-slate-900 p-2">
      {candidates.length > 0 && (
        <div>
          <p className="text-[11px] text-slate-500">ใกล้เคียง</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {candidates.map((candidate) => (
              <button
                key={candidate.name}
                type="button"
                onClick={() => pick(candidate.name)}
                className="rounded-full bg-slate-800 px-3 py-1.5 text-xs"
              >
                {candidate.name}
                <span className="ml-1 text-slate-500">{Math.round(candidate.score)}%</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="ค้นหาสินค้าที่มีอยู่"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
      />
      <ul className="max-h-48 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
        {filtered.length === 0 ? (
          <li className="px-3 py-2 text-xs text-slate-500">ไม่พบสินค้าที่ตรง</li>
        ) : (
          filtered.map((item) => (
            <li key={item.name}>
              <button
                type="button"
                onClick={() => pick(item.name)}
                className="w-full px-3 py-2 text-left text-sm"
              >
                {item.name}
                <span className="ml-2 text-xs text-slate-500">
                  {item.category === "food" ? "🍔" : "🧴"}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>

      <div className="flex gap-2">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="หรือตั้งชื่อใหม่ (ระบุยี่ห้อ/ขนาดด้วย)"
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
