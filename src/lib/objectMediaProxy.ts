import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { config } from "./config.js";
import {
  getStoredObject,
  headStoredObject,
  isObjectStorageConfigError,
  type StoredObjectMetadata,
} from "./objectStorage.js";

type MediaProxyOptions = {
  cacheControl: string | null,
  maxBytes: number,
  objectKey: string,
  routeName: string,
};

type RequestLogger = {
  error: (payload: unknown, message?: string) => void,
  info: (payload: unknown, message?: string) => void,
  warn: (payload: unknown, message?: string) => void,
};

function setMetadataHeaders(
  res: Response,
  metadata: StoredObjectMetadata,
  cacheControlOverride: string | null,
): void {
  res.setHeader("Content-Type", metadata.contentType);
  res.setHeader("Accept-Ranges", "none");

  if (metadata.contentLength != null) {
    res.setHeader("Content-Length", String(metadata.contentLength));
  }

  if (metadata.etag) {
    res.setHeader("ETag", metadata.etag);
  }

  if (metadata.lastModified) {
    res.setHeader("Last-Modified", metadata.lastModified.toUTCString());
  }

  const cacheControl = cacheControlOverride ?? metadata.cacheControl;
  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  }
}

function logRequest(
  req: Request,
  level: keyof RequestLogger,
  payload: Record<string, unknown>,
  message: string,
): void {
  const logger = (req as Request & { log?: RequestLogger }).log;
  logger?.[level](payload, message);
}

function buildLogContext(
  req: Request,
  options: MediaProxyOptions,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    routeName: options.routeName,
    objectKey: options.objectKey,
    method: req.method,
    routeHit: true,
    ...extra,
  };
}

export async function proxyStoredObjectResponse(
  req: Request,
  res: Response,
  options: MediaProxyOptions,
): Promise<void> {
  if (req.headers.range) {
    res.setHeader("Accept-Ranges", "none");
    res.status(416).end();
    logRequest(
      req,
      "warn",
      buildLogContext(req, options, { responseStatus: 416 }),
      "media route rejected range request",
    );
    return;
  }

  const abortSignal = AbortSignal.timeout(config.runtime.mediaProxyUpstreamTimeoutMs);

  try {
    if (req.method === "HEAD") {
      const startedAt = Date.now();
      const metadata = await headStoredObject(options.objectKey, { abortSignal });

      if (!metadata) {
        res.status(404).end();
        logRequest(
          req,
          "info",
          buildLogContext(req, options, {
            fetchLatencyMs: Date.now() - startedAt,
            r2Status: 404,
            responseStatus: 404,
          }),
          "media route object missing",
        );
        return;
      }

      if (metadata.contentLength != null && metadata.contentLength > options.maxBytes) {
        res.status(413).end();
        logRequest(
          req,
          "warn",
          buildLogContext(req, options, {
            bytesServed: 0,
            contentLength: metadata.contentLength,
            fetchLatencyMs: Date.now() - startedAt,
            maxBytes: options.maxBytes,
            r2Status: 200,
            responseStatus: 413,
          }),
          "media route rejected oversized object",
        );
        return;
      }

      setMetadataHeaders(res, metadata, options.cacheControl);
      res.status(200).end();
      logRequest(
        req,
        "info",
        buildLogContext(req, options, {
          bytesServed: 0,
          fetchLatencyMs: Date.now() - startedAt,
          r2Status: 200,
          responseStatus: 200,
        }),
        "media route served object metadata",
      );
      return;
    }

    const startedAt = Date.now();
    const storedObject = await getStoredObject(options.objectKey, { abortSignal });

    if (!storedObject) {
      res.status(404).end();
      logRequest(
        req,
        "info",
        buildLogContext(req, options, {
          fetchLatencyMs: Date.now() - startedAt,
          r2Status: 404,
          responseStatus: 404,
        }),
        "media route object missing",
      );
      return;
    }

    if (storedObject.contentLength != null && storedObject.contentLength > options.maxBytes) {
      storedObject.body.destroy();
      res.status(413).end();
      logRequest(
        req,
        "warn",
        buildLogContext(req, options, {
          bytesServed: 0,
          contentLength: storedObject.contentLength,
          fetchLatencyMs: Date.now() - startedAt,
          maxBytes: options.maxBytes,
          r2Status: 200,
          responseStatus: 413,
        }),
        "media route rejected oversized object",
      );
      return;
    }

    setMetadataHeaders(res, storedObject, options.cacheControl);
    res.status(200);

    let bytesServed = 0;
    const sizeGuard = new Transform({
      transform(chunk, _encoding, callback) {
        bytesServed += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (bytesServed > options.maxBytes) {
          callback(new Error("OBJECT_TOO_LARGE"));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(storedObject.body, sizeGuard, res);

    logRequest(
      req,
      "info",
      buildLogContext(req, options, {
        bytesServed,
        fetchLatencyMs: Date.now() - startedAt,
        r2Status: 200,
        responseStatus: 200,
      }),
      "media route streamed object",
    );
  } catch (err) {
    if (isObjectStorageConfigError(err)) {
      res.status(503).end();
      return;
    }

    const isOversizeError = err instanceof Error && err.message === "OBJECT_TOO_LARGE";
    if (isOversizeError) {
      if (!res.headersSent) {
        res.status(413).end();
      } else {
        res.destroy(err);
      }
      logRequest(
        req,
        "warn",
        buildLogContext(req, options, {
          maxBytes: options.maxBytes,
          responseStatus: 413,
        }),
        "media route exceeded size limit while streaming",
      );
      return;
    }

    if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.destroy(err as Error);
    }

    logRequest(
      req,
      "error",
      buildLogContext(req, options, { err, responseStatus: 502 }),
      "media route fetch failed",
    );
  }
}
