/**
 * Environment reads, hardened for dashboard-configured deployments.
 *
 * Two things are routine when values come from a hosting dashboard rather
 * than a .env file:
 *
 * - Pasted values pick up stray whitespace or tab characters. A leading
 *   tab on a URL is invisible in the UI and fails deep inside an HTTP
 *   client with an opaque parse error.
 * - A variable gets created but left blank. `process.env.X ?? fallback`
 *   keeps the empty string in that case, so a blank SHEETS_MOCK_MODE read
 *   as "not true" and silently pointed the app at the real Sheets API
 *   with no credentials.
 *
 * Trimming and treating blank as absent makes both harmless.
 */
export function env(name: string, fallback = ""): string {
  return (process.env[name] ?? "").trim() || fallback;
}

export function envFlag(name: string, fallback: boolean): boolean {
  return env(name, String(fallback)).toLowerCase() === "true";
}
