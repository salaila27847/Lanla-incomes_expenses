import { useRef, useState } from "react";

type ReceiptCategory = "food" | "goods";

interface ReceiptLineItem {
  id: string;
  rawText: string;
  price: number;
  category: ReceiptCategory;
  masterItemName: string;
  matched: boolean;
}

interface ScanResponseItem {
  id: string;
  raw_text: string;
  price: number;
  matched: boolean;
  master_item_name: string | null;
  category: ReceiptCategory | null;
  score: number;
}

interface ScanResponse {
  store: string | null;
  purchased_at: string | null;
  items: ScanResponseItem[];
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

type Status = "idle" | "scanning" | "reviewing" | "saving" | "saved" | "error";

export default function ReceiptReview() {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [purchasedAt, setPurchasedAt] = useState<string | null>(null);
  const [items, setItems] = useState<ReceiptLineItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setStatus("scanning");
    setErrorMessage(null);

    try {
      const formData = new FormData();
      formData.append("image", file);
      const response = await fetch(`${API_BASE_URL}/receipt/scan`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`สแกนไม่สำเร็จ (${response.status})`);
      }
      const result: ScanResponse = await response.json();
      setStore(result.store);
      setPurchasedAt(result.purchased_at);
      setItems(
        result.items.map((item) => ({
          id: item.id,
          rawText: item.raw_text,
          price: item.price,
          category: item.category ?? "food",
          masterItemName: item.master_item_name ?? "",
          matched: item.matched,
        })),
      );
      setStatus("reviewing");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
      setStatus("error");
    }
  }

  function toggleCategory(id: string) {
    setItems((prev) =>
      prev.map((item) =>
        item.id === id
          ? { ...item, category: item.category === "food" ? "goods" : "food" }
          : item,
      ),
    );
  }

  function setMasterItemName(id: string, name: string) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, masterItemName: name } : item)));
  }

  const canSave = items.length > 0 && items.every((item) => item.masterItemName.trim().length > 0);

  async function handleSave() {
    setStatus("saving");
    setErrorMessage(null);
    try {
      const response = await fetch(`${API_BASE_URL}/receipt/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          store,
          purchased_at: purchasedAt,
          items: items.map((item) => ({
            raw_text: item.rawText,
            price: item.price,
            master_item_name: item.masterItemName.trim(),
            category: item.category,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(`บันทึกไม่สำเร็จ (${response.status})`);
      }
      setStatus("saved");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
      setStatus("error");
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">สแกนสลิป</h2>
        <p className="text-sm text-slate-400">
          ถ่ายรูปสลิปเพื่อแยกรายการ [🍔 กิน] / [🧴 ใช้] และจับคู่ชื่อสินค้ามาตรฐาน
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFileSelected}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={status === "scanning" || status === "saving"}
        className="w-full rounded-lg border border-dashed border-slate-700 py-6 text-sm text-slate-400 disabled:opacity-50"
      >
        {status === "scanning" ? "กำลังสแกน..." : "แตะเพื่อถ่ายรูปสลิป"}
      </button>

      {status === "error" && errorMessage && (
        <p className="text-sm text-red-400">{errorMessage}</p>
      )}
      {status === "saved" && <p className="text-sm text-emerald-400">บันทึกสำเร็จ</p>}

      {items.length === 0 ? (
        <p className="text-sm text-slate-500">ยังไม่มีรายการให้ตรวจสอบ</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-800">
            {items.map((item) => (
              <li key={item.id} className="space-y-2 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500">{item.rawText}</p>
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
                </div>
                {item.matched ? (
                  // TODO: turn this into a search-dropdown autocomplete so the
                  // user can also re-pick a different master item in 1 tap.
                  <p className="text-sm">{item.masterItemName}</p>
                ) : (
                  <input
                    value={item.masterItemName}
                    onChange={(event) => setMasterItemName(item.id, event.target.value)}
                    placeholder="ตั้งชื่อสินค้ามาตรฐาน (ไม่พบในระบบ)"
                    className="w-full rounded-lg border border-amber-700 bg-slate-900 px-3 py-2 text-sm"
                  />
                )}
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave || status === "saving"}
            className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium disabled:opacity-50"
          >
            {status === "saving" ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        </>
      )}
    </section>
  );
}
