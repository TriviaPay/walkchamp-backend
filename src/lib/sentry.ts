import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Minimal, dependency-free Sentry reporter (audit 2026-08-17 M20). Before this, `SENTRY_DSN` was
 * plumbed into the container but nothing ever reported to it — api and worker crashes reached no one.
 *
 * We deliberately do NOT use `@sentry/node`: its transitive `@opentelemetry/*` graph is externalized
 * in the esbuild bundle and is not resolvable at runtime in this repo, so importing it breaks server
 * startup. Instead we POST events straight to the Sentry ingestion (store) endpoint over HTTP, which
 * needs no dependencies and cannot break the build. This captures exceptions and, once initialized,
 * process-level uncaughtException / unhandledRejection — enough to end the "shipping blind" gap.
 */

type SentryTarget = { endpoint: string; publicKey: string };
let target: SentryTarget | null = null;
let environment = "production";
let componentTag = "api";
let initialized = false;

/** Parse a DSN like https://<publicKey>@<host>/<projectId> into the store endpoint + key. */
function parseDsn(dsn: string): SentryTarget | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, "");
    if (!url.username || !projectId) return null;
    return {
      publicKey: url.username,
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/store/`,
    };
  } catch {
    return null;
  }
}

function post(event: Record<string, unknown>): void {
  if (!target) return;
  // Fire-and-forget; never let reporting failures affect the request/job that triggered it.
  void fetch(target.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=walkchamp/1.0, sentry_key=${target.publicKey}`,
    },
    body: JSON.stringify(event),
  }).catch(() => {});
}

/** Idempotent. No-op when SENTRY_DSN is unset (local/dev). `component` tags api vs worker. */
export function initSentry(component: "api" | "worker"): void {
  if (initialized) return;
  initialized = true;
  componentTag = component;
  environment = config.sentry.environment;
  if (!config.sentry.dsn) {
    logger.info({ component }, "Sentry DSN not set — error reporting disabled");
    return;
  }
  target = parseDsn(config.sentry.dsn);
  if (!target) {
    logger.warn({ component }, "SENTRY_DSN is malformed — error reporting disabled");
    return;
  }
  // Report process-level failures. Additive listeners (do not exit here — process-safety owns the
  // shutdown decision); we only mirror the crash to Sentry.
  process.on("uncaughtException", (err) => captureException(err, { origin: "uncaughtException" }));
  process.on("unhandledRejection", (reason) => captureException(reason, { origin: "unhandledRejection" }));
  logger.info({ component, environment }, "Sentry reporter initialized");
}

/** Report a handled exception with optional context. No-op until initSentry runs with a valid DSN. */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!target) return;
  const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : JSON.stringify(err));
  post({
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    environment,
    tags: { component: componentTag },
    ...(context ? { extra: context } : {}),
    exception: {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: error.stack ? { frames: [{ function: error.stack.split("\n")[1]?.trim() ?? "" }] } : undefined,
        },
      ],
    },
  });
}
