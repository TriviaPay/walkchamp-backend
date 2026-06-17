import express, {
  type Express,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import cors from "cors";
import helmetImport from "helmet";
import type { HelmetOptions } from "helmet";
import compression from "compression";
import { pinoHttp } from "pino-http";
import { rateLimit } from "express-rate-limit";
import router from "./routes";
import { recoverStaleRaces, cleanupOverdueRaces } from "./routes/races";
import { startScheduler } from "./lib/scheduler";
import { logger } from "./lib/logger";

// Helmet publishes CJS-style types; cast keeps ESM default import compatible with strict TS.
const helmet = helmetImport as unknown as (
  options?: Readonly<HelmetOptions>,
) => RequestHandler;

// ── Env validation — fail fast before any DB connections ─────────────────────
const REQUIRED_ENV_VARS = [
  "NEON_DATABASE_URL",
  "DESCOPE_PROJECT_ID",
  "SESSION_SECRET",
];
const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  logger.fatal({ missingVars }, "Missing required environment variables — refusing to start");
  process.exit(1);
}

// Warn in production when payment webhook secrets are absent — they default to
// "disabled" mode which silently accepts unsigned webhooks in dev but MUST be
// set in prod to prevent fake payment injection.
const isProd = process.env.NODE_ENV === "production";
if (isProd) {
  const warnIfMissing = (name: string) => {
    if (!process.env[name]) {
      logger.warn({ var: name }, `[Security] ${name} is not set — payment webhooks will be rejected in production`);
    }
  };
  warnIfMissing("STRIPE_WEBHOOK_SECRET");
  warnIfMissing("RAZORPAY_WEBHOOK_SECRET");
  if (!process.env.ALLOWED_ORIGINS) {
    logger.warn("[Security] ALLOWED_ORIGINS is not set — CORS allows all origins in production");
  }
}

const app: Express = express();

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
// (comma-separated list of origin prefixes). In development, allow all.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.some((o) => origin.startsWith(o))
      ) {
        callback(null, true);
      } else {
        callback(new Error("CORS: origin not allowed"));
      }
    },
    credentials: true,
  }),
);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Global guard — prevents abuse from a single IP flooding any endpoint.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please try again later." },
  skip: (req: Request) => req.path.startsWith("/api/webhooks/"),
});

// Tighter limit for auth endpoints (login, token verify, username check, etc.)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth requests — please try again later." },
});

// Payment and deposit endpoints — any IP that hits these 20×/15min is suspicious.
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment requests — please try again later." },
});

// Race registration / cancellation — prevent room-fill spam.
const registrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration requests — please slow down." },
});

app.use(globalLimiter);
app.use("/api/auth", authLimiter);
app.use("/api/deposit", paymentLimiter);
app.use("/api/payments", paymentLimiter);
app.use("/api/rooms/:roomId/register", registrationLimiter);
app.use("/api/rooms/:roomId/cancel-registration", registrationLimiter);

// ── Request logging ───────────────────────────────────────────────────────────
app.use(
  pinoHttp({
    logger,
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

// ── Body parsing — Stripe/Razorpay webhooks need raw body ─────────────────────
// All other routes get parsed JSON with a 2 MB body limit.
const WEBHOOK_PATHS = new Set([
  "/api/payments/webhook",
  "/api/webhooks/stripe",
  "/api/webhooks/razorpay",
]);

app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) {
    express.raw({ type: "application/json", limit: "1mb" })(req, res, next);
  } else {
    express.json({ limit: "2mb" })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Response compression ───────────────────────────────────────────────────────
// Compresses JSON/text responses. Webhook paths receive raw buffers so they are
// naturally excluded (compression only runs on text content-types).
app.use(compression());

app.use("/api", router);

// ── Background jobs ───────────────────────────────────────────────────────────
recoverStaleRaces().catch(() => {});
setInterval(() => { cleanupOverdueRaces().catch(() => {}); }, 15_000);
startScheduler();

export default app;
