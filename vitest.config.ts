import { defineConfig } from "vitest/config";

const listenerTests = [
  "src/__tests__/integration-http.test.ts",
  "src/__tests__/object-media-proxy.test.ts",
];
const runListenerTests = process.env.VITEST_HTTP_LISTENERS === "1";
const listenerTestsBlocked = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: runListenerTests ? listenerTests : ["src/__tests__/**/*.test.ts"],
    exclude: !runListenerTests && listenerTestsBlocked ? listenerTests : [],
    globals: false,
    fileParallelism: false,
  },
});
