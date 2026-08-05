/**
 * The Settings tab, typed.
 *
 * Values arrive from the Sheet as strings — possibly blank, possibly typed
 * by hand with a thousands separator — so every one needs parsing and a
 * default. Shared by /dashboard and /budget rather than living in either.
 */
import { readSettings, writeSettings } from "./sheets/client";

export const SETTING_KEYS = {
  openingBalance: "opening_balance",
  cycleBudgetFood: "cycle_budget_food",
  cycleBudgetGoods: "cycle_budget_goods",
} as const;

export type SettingField = keyof typeof SETTING_KEYS;

// The two caps are per *pay cycle*, not per day: the user's own spreadsheet
// reads "เป้าหมาย 5,000/เดือน" and their actual spend lands at 4,000–6,000
// a month, so a daily cap of 5,000 could never be reached.
export const SETTING_DEFAULTS: Record<SettingField, number> = {
  openingBalance: 0,
  cycleBudgetFood: 5000,
  cycleBudgetGoods: 5000,
};

export type Settings = Record<SettingField, number>;

function parse(raw: string | undefined, fallback: number): number {
  const text = (raw ?? "").replace(/,/g, "").trim();
  if (text === "") return fallback;
  const value = Number(text);
  return Number.isFinite(value) ? value : fallback;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await readSettings();
  return {
    openingBalance: parse(raw[SETTING_KEYS.openingBalance], SETTING_DEFAULTS.openingBalance),
    cycleBudgetFood: parse(raw[SETTING_KEYS.cycleBudgetFood], SETTING_DEFAULTS.cycleBudgetFood),
    cycleBudgetGoods: parse(raw[SETTING_KEYS.cycleBudgetGoods], SETTING_DEFAULTS.cycleBudgetGoods),
  };
}

export async function saveSettings(updates: Partial<Settings>): Promise<Settings> {
  await writeSettings(
    Object.fromEntries(
      Object.entries(updates)
        .filter(([, value]) => value !== undefined)
        .map(([field, value]) => [SETTING_KEYS[field as SettingField], String(value)]),
    ),
  );
  return loadSettings();
}
