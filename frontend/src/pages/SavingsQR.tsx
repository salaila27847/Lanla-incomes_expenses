import { useState } from "react";

export default function SavingsQR() {
  const [amount, setAmount] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  async function handleShowQr() {
    // TODO: call controller's GET/POST /qr (proxies to the Python backend's
    // PromptPay QR generator) with `amount`, then setQrDataUrl(response.qrDataUrl)
    setQrDataUrl(null);
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

      <button
        type="button"
        onClick={handleShowQr}
        className="w-full rounded-lg bg-sky-600 py-2 text-sm font-medium"
      >
        แสดง QR Code
      </button>

      {qrDataUrl && (
        <div className="rounded-lg border border-slate-800 p-4 text-center">
          <img src={qrDataUrl} alt="PromptPay QR" className="mx-auto" />
        </div>
      )}
    </section>
  );
}
