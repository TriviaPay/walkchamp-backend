import express, {
  type Express,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import { randomUUID } from "node:crypto";
import cors from "cors";
import helmetImport from "helmet";
import type { HelmetOptions } from "helmet";
import compression from "compression";
import { pinoHttp } from "pino-http";
import router from "./routes/index.js";
import healthRouter from "./routes/health.js";
import { logger } from "./lib/logger.js";
import { config } from "./lib/config.js";
import {
  createRedisRateLimit,
  rateLimitByActorOrIp,
  rateLimitByIp,
} from "./lib/rateLimit.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { loadSheddingMiddleware } from "./middleware/loadShedding.js";
import { resourceBudgetMiddleware } from "./middleware/resourceBudgets.js";

// Helmet publishes CJS-style types; cast keeps ESM default import compatible with strict TS.
const helmet = helmetImport as unknown as (
  options?: Readonly<HelmetOptions>,
) => RequestHandler;

function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

function authRateLimitTarget(req: Request): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const username = typeof req.query.username === "string" ? req.query.username : null;
  const email = typeof body?.email === "string" ? body.email : null;
  const phone = typeof body?.phone === "string" ? body.phone : null;
  const loginId = typeof body?.loginId === "string" ? body.loginId : null;
  const descopeUserId = typeof body?.descopeUserId === "string" ? body.descopeUserId : null;
  return username ?? email ?? phone ?? loginId ?? descopeUserId;
}

const apiNoStoreMiddleware: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cloudflare-CDN-Cache-Control", "no-store");
  res.setHeader("CDN-Cache-Control", "no-store");
  res.setHeader("Surrogate-Control", "no-store");
  next();
};

const app: Express = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://checkout.razorpay.com",
          "https://unpkg.com",
          "https://js.stripe.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: ["https://api.razorpay.com", "https://js.stripe.com"],
        connectSrc: [
          "'self'",
          "https://api.razorpay.com",
          "https://api.stripe.com",
        ],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  }),
);

// ── CORS ──────────────────────────────────────────────────────────────────────
// In production, restrict to known origins via ALLOWED_ORIGINS env var
// (comma-separated exact origins). In development, allow all.
const allowedOrigins = config.allowedOrigins.length > 0
  ? config.allowedOrigins
  : parseAllowedOrigins("");

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (!config.isProduction && allowedOrigins.length === 0) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("CORS: origin not allowed"));
      }
    },
    credentials: true,
  }),
);

// ── Request logging ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
    genReqId(req, res) {
      const header = req.headers["x-request-id"];
      const requestId = typeof header === "string" && header.trim() ? header.trim() : randomUUID();
      res.setHeader("X-Request-Id", requestId);
      return requestId;
    },
    serializers: {
      req(req: Request) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: Response) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

if (config.features.loadSheddingEnabled) {
  app.use(loadSheddingMiddleware);
}

// ── Timeouts ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const isUploadRoute = /^\/api\/(?:profile\/me\/avatar|groups\/[^/]+\/image)$/.test(req.path);
  const isMediaProxyRoute = /^\/api\/(?:profile\/avatar\/[^/]+|groups\/[^/]+\/image|track-themes\/[^/]+\/image)$/.test(req.path);
  const requestTimeoutMs = isUploadRoute
    ? config.runtime.uploadTimeoutMs
    : isMediaProxyRoute
      ? config.runtime.mediaProxyTimeoutMs
      : config.runtime.requestTimeoutMs;
  const responseTimeoutMs = isUploadRoute
    ? config.runtime.uploadTimeoutMs
    : isMediaProxyRoute
      ? config.runtime.mediaProxyTimeoutMs
      : config.runtime.responseTimeoutMs;

  let timedOut = false;
  const onTimeout = () => {
    if (timedOut || res.headersSent) return;
    timedOut = true;
    req.log.warn({ path: req.path }, "Request timed out");
    res.status(408).json({
      error: "Request timed out.",
      code: "REQUEST_TIMEOUT",
      requestId: (req as Request & { id?: string }).id ?? null,
    });
  };

  req.setTimeout(requestTimeoutMs);
  res.setTimeout(responseTimeoutMs, onTimeout);
  next();
});

// ── CDN cache deny-by-default ─────────────────────────────────────────────────
// API responses are private unless a route deliberately overrides every cache
// header (media compatibility routes do this for versioned public images).
app.use("/api", apiNoStoreMiddleware);

// ── Body parsing — Stripe/Razorpay webhooks need raw body ─────────────────────
// All other routes get parsed JSON with a 2 MB body limit.
const WEBHOOK_PATHS = new Set([
  "/api/payments/webhook",
  "/api/webhooks/stripe",
  "/api/webhooks/razorpay",
]);
const HEALTH_PATHS = new Set(["/livez", "/healthz", "/readyz", "/api/livez", "/api/healthz", "/api/readyz"]);

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) {
    express.raw({ type: "application/json", limit: "1mb" })(req, res, next);
  } else {
    express.json({ limit: config.runtime.jsonBodyLimit })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true, limit: config.runtime.urlencodedBodyLimit }));
app.use(resourceBudgetMiddleware);

// ── Response compression ───────────────────────────────────────────────────────
// Compresses JSON/text responses. Webhook paths receive raw buffers so they are
// naturally excluded (compression only runs on text content-types).
app.use(compression());

app.use(healthRouter);

// ── Rate limiting ─────────────────────────────────────────────────────────────
if (config.features.rateLimitingEnabled) {
  const globalLimiter = createRedisRateLimit({
    bucket: "global",
    windowMs: 15 * 60 * 1000,
    max: 400,
    failureMode: "open",
    enforcement: "monitor",
    message: "Too many requests — please try again later.",
    code: "GLOBAL_RATE_LIMITED",
    key: rateLimitByIp,
    dimensions: ["ip", "device"],
  });
  app.use((req, res, next) => (
    WEBHOOK_PATHS.has(req.path) || HEALTH_PATHS.has(req.path)
      ? next()
      : globalLimiter(req, res, next)
  ));
  app.use("/api/auth", createRedisRateLimit({
    bucket: "auth",
    windowMs: 60 * 1000,
    max: 20,
    failureMode: "closed",
    message: "Too many auth requests — please try again later.",
    code: "AUTH_RATE_LIMITED",
    key: rateLimitByIp,
    dimensions: ["ip", "device", "token", "target"],
    target: authRateLimitTarget,
  }));
  app.use("/api/payments", createRedisRateLimit({
    bucket: "payments",
    windowMs: 15 * 60 * 1000,
    max: 20,
    failureMode: "closed",
    message: "Too many payment requests — please try again later.",
    code: "PAYMENT_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
  }));
  app.use("/api/wallet/deposit", createRedisRateLimit({
    bucket: "deposits",
    windowMs: 15 * 60 * 1000,
    max: 10,
    failureMode: "closed",
    message: "Too many deposit attempts — please try again later.",
    code: "DEPOSIT_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
  }));
  app.use("/api/admin", createRedisRateLimit({
    bucket: "admin",
    windowMs: 15 * 60 * 1000,
    max: 60,
    failureMode: "closed",
    message: "Too many admin requests — please try again later.",
    code: "ADMIN_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "token"],
  }));
  app.use("/api/realtime/pusher/auth", createRedisRateLimit({
    bucket: "realtime-auth",
    windowMs: 60 * 1000,
    max: 60,
    failureMode: "open",
    message: "Too many realtime auth requests — please slow down.",
    code: "REALTIME_AUTH_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
    enforcement: "monitor",
  }));
  app.use("/api/presence/heartbeat", createRedisRateLimit({
    bucket: "presence-heartbeat",
    windowMs: 60 * 1000,
    max: 120,
    failureMode: "open",
    message: "Too many presence updates — please slow down.",
    code: "PRESENCE_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
    enforcement: "monitor",
  }));
  app.use("/api/coins/ad-reward", createRedisRateLimit({
    bucket: "ad-reward",
    windowMs: 15 * 60 * 1000,
    max: 30,
    failureMode: "open",
    message: "Too many ad reward requests — please try again later.",
    code: "AD_REWARD_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
    enforcement: "monitor",
  }));
  app.use("/api/rooms", createRedisRateLimit({
    bucket: "room-registration",
    windowMs: 60 * 1000,
    max: 20,
    failureMode: "open",
    message: "Too many registration requests — please slow down.",
    code: "ROOM_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
    enforcement: "monitor",
  }));
  app.use("/api/races", createRedisRateLimit({
    bucket: "race-join",
    windowMs: 60 * 1000,
    max: 20,
    failureMode: "open",
    message: "Too many race requests — please slow down.",
    code: "RACE_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
    enforcement: "monitor",
  }));
  // Step-submission endpoints write persistent state and drive coin rewards /
  // leaderboards; without a limiter a single account can spam them. Generous
  // per-actor caps that legitimate periodic syncs stay well under.
  app.use("/api/walk", createRedisRateLimit({
    bucket: "walk-steps",
    windowMs: 60 * 1000,
    max: 60,
    failureMode: "open",
    message: "Too many step updates — please slow down.",
    code: "WALK_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
  }));
  app.use("/api/groups/steps", createRedisRateLimit({
    bucket: "group-steps",
    windowMs: 60 * 1000,
    max: 30,
    failureMode: "open",
    message: "Too many step updates — please slow down.",
    code: "GROUP_STEPS_RATE_LIMITED",
    key: rateLimitByActorOrIp,
    dimensions: ["ip", "actor", "device", "token"],
  }));
}

app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
