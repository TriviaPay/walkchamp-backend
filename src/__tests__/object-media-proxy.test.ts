import express from "express";
import { type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const headStoredObject = vi.fn();
const getStoredObject = vi.fn();

vi.mock("../lib/objectStorage", () => ({
  getStoredObject,
  headStoredObject,
  isObjectStorageConfigError: vi.fn(() => false),
}));

let proxyStoredObjectResponse: typeof import("../lib/objectMediaProxy").proxyStoredObjectResponse;

type LogEntry = {
  level: "info" | "warn" | "error",
  message?: string,
  payload: Record<string, unknown>,
};

beforeAll(async () => {
  ({ proxyStoredObjectResponse } = await import("../lib/objectMediaProxy"));
});

afterEach(() => {
  headStoredObject.mockReset();
  getStoredObject.mockReset();
});

async function withTestServer(
  handlerOptions?: Partial<{
    cacheControl: string | null,
    maxBytes: number,
    objectKey: string,
    routeName: string,
  }>,
): Promise<{
  baseUrl: string,
  close: () => Promise<void>,
  logs: LogEntry[],
}> {
  const logs: LogEntry[] = [];
  const app = express();

  app.use((req, _res, next) => {
    (req as any).log = {
      info: (payload: Record<string, unknown>, message?: string) => {
        logs.push({ level: "info", payload, message });
      },
      warn: (payload: Record<string, unknown>, message?: string) => {
        logs.push({ level: "warn", payload, message });
      },
      error: (payload: Record<string, unknown>, message?: string) => {
        logs.push({ level: "error", payload, message });
      },
    };
    next();
  });

  const handler = (req: express.Request, res: express.Response) => proxyStoredObjectResponse(req, res, {
    routeName: handlerOptions?.routeName ?? "avatar-media",
    objectKey: handlerOptions?.objectKey ?? "avatars/user-1/avatar.png",
    maxBytes: handlerOptions?.maxBytes ?? 5,
    cacheControl: handlerOptions?.cacheControl ?? "public, max-age=60",
  });

  app.get("/media", handler);
  app.head("/media", handler);

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const started = app.listen(0, () => resolve(started));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    logs,
  };
}

describe("proxyStoredObjectResponse", () => {
  it("streams GET responses with header pass-through", async () => {
    getStoredObject.mockResolvedValue({
      body: Readable.from([Buffer.from("hello")]),
      contentType: "image/png",
      contentLength: 5,
      cacheControl: "public, max-age=31536000, immutable",
      etag: "\"etag-123\"",
      lastModified: new Date("2026-01-01T00:00:00.000Z"),
    });

    const server = await withTestServer();
    try {
      const response = await fetch(`${server.baseUrl}/media`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-length")).toBe("5");
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
      expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=60");
      expect(response.headers.get("cdn-cache-control")).toBe("public, max-age=60");
      expect(response.headers.get("surrogate-control")).toBe("public, max-age=60");
      expect(response.headers.get("etag")).toBe("\"etag-123\"");
      expect(response.headers.get("last-modified")).toBeTruthy();
      expect(await response.text()).toBe("hello");

      expect(server.logs).toContainEqual(expect.objectContaining({
        level: "info",
        message: "media route streamed object",
        payload: expect.objectContaining({
          routeName: "avatar-media",
          objectKey: "avatars/user-1/avatar.png",
          responseStatus: 200,
          bytesServed: 5,
          routeHit: true,
        }),
      }));
    } finally {
      await server.close();
    }
  });

  it("supports HEAD without fetching the body", async () => {
    headStoredObject.mockResolvedValue({
      contentType: "image/webp",
      contentLength: 4,
      cacheControl: null,
      etag: "\"head-etag\"",
      lastModified: new Date("2026-02-02T00:00:00.000Z"),
    });

    const server = await withTestServer({ cacheControl: null });
    try {
      const response = await fetch(`${server.baseUrl}/media`, { method: "HEAD" });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("etag")).toBe("\"head-etag\"");
      expect(await response.text()).toBe("");
      expect(getStoredObject).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects range requests consistently", async () => {
    const server = await withTestServer();
    try {
      const response = await fetch(`${server.baseUrl}/media`, {
        headers: { Range: "bytes=0-1" },
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("accept-ranges")).toBe("none");
      expect(getStoredObject).not.toHaveBeenCalled();
      expect(headStoredObject).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns 404 for missing objects", async () => {
    getStoredObject.mockResolvedValue(null);

    const server = await withTestServer();
    try {
      const response = await fetch(`${server.baseUrl}/media`);
      expect(response.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("rejects objects larger than the configured max size", async () => {
    getStoredObject.mockResolvedValue({
      body: Readable.from([Buffer.from("too-big")]),
      contentType: "image/png",
      contentLength: 7,
      cacheControl: null,
      etag: null,
      lastModified: null,
    });

    const server = await withTestServer({ maxBytes: 5 });
    try {
      const response = await fetch(`${server.baseUrl}/media`);
      expect(response.status).toBe(413);
    } finally {
      await server.close();
    }
  });
});
