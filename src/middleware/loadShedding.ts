import { monitorEventLoopDelay } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../../db/src/index.js";

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

let activeRequests = 0;
const healthPaths = new Set(["/livez", "/healthz", "/readyz", "/api/livez", "/api/healthz", "/api/readyz"]);

function requestIdOf(req: Request): string | null {
  return (req as Request & { id?: string }).id ?? null;
}

export function loadSheddingMiddleware(req: Request, res: Response, next: NextFunction) {
  const waitingCount = typeof pool.waitingCount === "number" ? pool.waitingCount : 0;
  const eventLoopP95Ms = loopDelay.percentile(95) / 1_000_000;
  const overloaded =
    activeRequests > 250
    || waitingCount > 10
    || eventLoopP95Ms > 250;

  if (overloaded && !healthPaths.has(req.path)) {
    res.setHeader("Retry-After", "5");
    return res.status(503).json({
      error: "Service is temporarily overloaded.",
      code: "SERVICE_OVERLOADED",
      requestId: requestIdOf(req),
    });
  }

  activeRequests += 1;
  res.on("finish", () => {
    activeRequests = Math.max(0, activeRequests - 1);
  });
  return next();
}

export function getRuntimeLoadState() {
  return {
    activeRequests,
    dbPoolWaitingCount: typeof pool.waitingCount === "number" ? pool.waitingCount : 0,
    eventLoopP95Ms: loopDelay.percentile(95) / 1_000_000,
  };
}
