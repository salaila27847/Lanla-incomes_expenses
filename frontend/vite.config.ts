import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Smart Expense & Price Tracker",
        short_name: "ExpenseTracker",
        description: "สแกนสลิป แยกหมวดหมู่ ติดตามงบประมาณและประวัติราคาสินค้า",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            // TODO: replace with real 192x192 / 512x512 PNG icons before shipping
            src: "vite.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
  },
});
