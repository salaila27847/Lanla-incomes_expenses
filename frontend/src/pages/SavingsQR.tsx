import { useState } from "react";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export default function SavingsQR() {
  const [amount, setAmount] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleShowQr() {
    const amountThb = Number(amount);
    if (!amountThb || amountThb <= 0) {
      setErrorMessage("กรุณาระบุจำนวนเงินให้ถูกต้อง");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setQrDataUrl(null);
    try {
      const response = await fetch(`${API_BASE_URL}/qr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_thb: amountThb }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `สร้าง QR ไม่สำเร็จ (${response.status})`);
      }
      const result: { qr_data_url: string } = await response.json();
      setQrDataUrl(result.qr_data_url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-medium">จ่ายด้วยบัญชีเงินออม</h2>
        <p className="text-sm text-slate-400">
          ระบุยอดเงิน ระบบจะสร้าง PromptPay QR สำหรับโอนเงินคืนจากบัญชีหลักเข้าบัญชีออม
        </p>
      </div>

      <input
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        inputMode="decimal"
        placeholder="จำนวนเงิน (บาท)"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
      />

      {errorMessage && <p className="text-sm text-red-400">{errorMessage}</p>}

      <button
        type="button"
        onClick={handleShowQr}
        disabled={loading}
        className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium disabled:opacity-50"
      >
        {loading ? "กำลังสร้าง QR..." : "แสดง QR Code"}
      </button>

      {qrDataUrl && (
        <div className="rounded-lg border border-slate-800 p-4 text-center">
          <img src={qrDataUrl} alt="PromptPay QR" className="mx-auto" />
        </div>
      )}
    </section>
  );
}
