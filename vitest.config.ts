import { defineConfig } from "vitest/config";

const listenerTests = [
  "src/__tests__/integration-http.test.ts",
  "src/__tests__/object-media-proxy.test.ts",
];
const runListenerTests = process.env.VITEST_HTTP_LISTENERS === "1";
const runDbTests = process.env.VITEST_DB === "1";
const listenerTestsBlocked = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
const include = runListenerTests
  ? listenerTests
  : runDbTests
    ? ["src/__tests__/**/*.db.test.ts"]
    : ["src/__tests__/**/*.test.ts"];

export default defineConfig({
  test: {
    environment: "node",
    include,
    exclude: !runListenerTests && !runDbTests && listenerTestsBlocked ? listenerTests : [],
    globals: false,
    fileParallelism: false,
  },
});
