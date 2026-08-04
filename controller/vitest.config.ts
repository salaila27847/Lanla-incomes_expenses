import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // sheets/client.ts caches SHEETS_MOCK_MODE and its in-memory tabs at
    // module scope, so tests reset modules and re-import to get clean
    // state. That only works if files don't share a module registry.
    isolate: true,
  },
});
