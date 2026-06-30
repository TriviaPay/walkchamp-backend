import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const BASE_PRODUCTION_ENV = {
  NODE_ENV: "production",
  PORT: "8080",
  LOG_LEVEL: "info",
  APP_BASE_URL: "https://api.example.com",
  ALLOWED_ORIGINS: "https://app.example.com",
  DATABASE_RUNTIME_URL: "postgres://test:test@127.0.0.1:5432/test",
  DATABASE_ADMIN_URL: "postgres://test:test@127.0.0.1:5432/test",
  REDIS_URL: "redis://127.0.0.1:6379",
  DESCOPE_PROJECT_ID: "descope-project",
  OBJECT_STORAGE_ENDPOINT: "https://example-account.r2.cloudflarestorage.com",
  OBJECT_STORAGE_REGION: "auto",
  OBJECT_STORAGE_BUCKET: "walkchamp-assets",
  OBJECT_STORAGE_ACCESS_KEY_ID: "access-key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-key",
  OBJECT_STORAGE_PUBLIC_BASE_URL: "https://assets.example.com",
} as const;

async function importConfig(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV, ...BASE_PRODUCTION_ENV };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return import("../lib/config");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("production object storage config", () => {
  it("requires OBJECT_STORAGE_ENDPOINT in production", async () => {
    await expect(importConfig({ OBJECT_STORAGE_ENDPOINT: undefined })).rejects.toThrow(
      "OBJECT_STORAGE_ENDPOINT is required in production",
    );
  });

  it("does not accept legacy OCI vars as a production fallback", async () => {
    await expect(importConfig({
      OBJECT_STORAGE_ENDPOINT: undefined,
      OBJECT_STORAGE_BUCKET: undefined,
      OBJECT_STORAGE_ACCESS_KEY_ID: undefined,
      OBJECT_STORAGE_SECRET_ACCESS_KEY: undefined,
      OBJECT_STORAGE_PUBLIC_BASE_URL: undefined,
      OCI_NAMESPACE: "legacy-namespace",
      OCI_REGION: "us-ashburn-1",
      OCI_BUCKET_NAME: "legacy-bucket",
      OCI_ACCESS_KEY_ID: "legacy-access-key",
      OCI_SECRET_ACCESS_KEY: "legacy-secret-key",
    })).rejects.toThrow("OBJECT_STORAGE_ENDPOINT is required in production");
  });
});
