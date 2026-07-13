import { z } from "zod";

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  return value === "true";
}

function splitCsv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBloomGuardsMode(value: string | undefined): "off" | "monitor" | "enforce" {
  if (value === "off" || value === "monitor" || value === "enforce") return value;
  return "monitor";
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    LOG_LEVEL: z.string().default("info"),
    APP_BASE_URL: z.string().optional(),
    ALLOWED_ORIGINS: z.string().optional(),
    RUN_BACKGROUND_JOBS: z.enum(["true", "false"]).optional(),
    ENABLE_RATE_LIMITING: z.enum(["true", "false"]).optional(),
    ENABLE_NEW_RATE_LIMITER: z.enum(["true", "false"]).optional(),
    ENABLE_CACHE_GET_OR_COMPUTE: z.enum(["true", "false"]).optional(),
    ENABLE_LOAD_SHEDDING: z.enum(["true", "false"]).optional(),
    ENABLE_BULLMQ_WEBHOOK_PROCESSING: z.enum(["true", "false"]).optional(),
    ENABLE_CIRCUIT_BREAKERS: z.enum(["true", "false"]).optional(),
    ENABLE_EDGE_STRICT_MODE: z.enum(["true", "false"]).optional(),
    BLOOM_GUARDS_MODE: z.enum(["off", "monitor", "enforce"]).optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(1).optional(),
    TRUST_PROXY_CIDRS: z.string().optional(),
    READINESS_DETAIL_TOKEN: z.string().optional(),
    MOCK_PROVIDERS_ENABLED: z.enum(["true", "false"]).optional(),
    ALLOW_TEST_ROUTES: z.enum(["true", "false"]).optional(),
    ALLOW_DEMO_SEEDS: z.enum(["true", "false"]).optional(),
    NEON_DATABASE_URL: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    DATABASE_RUNTIME_URL: z.string().optional(),
    DATABASE_ADMIN_URL: z.string().optional(),
    NEON_DATABASE_ADMIN_URL: z.string().optional(),
    REDIS_URL: z.string().optional(),
    REDIS_CACHE_URL: z.string().optional(),
    REDIS_QUEUE_URL: z.string().optional(),
    RATE_LIMIT_SECRET: z.string().optional(),
    DESCOPE_PROJECT_ID: z.string().optional(),
    DESCOPE_MANAGEMENT_KEY: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    CASH_FEATURES_ENABLED: z.enum(["true", "false"]).optional(),
    FEATURE_CASH_FEATURES: z.enum(["true", "false"]).optional(),
    FEATURE_COIN_ENTRY_CHALLENGES: z.enum(["true", "false"]).optional(),
    PAYMENTS_LIVE_MODE: z.enum(["true", "false"]).optional(),
    REAL_MONEY_PRODUCTION_APPROVED: z.enum(["true", "false"]).optional(),
    REAL_MONEY_LEGAL_APPROVED: z.enum(["true", "false"]).optional(),
    REAL_MONEY_KYC_TAX_READY: z.enum(["true", "false"]).optional(),
    REAL_MONEY_PROVIDER_SANDBOX_TESTED: z.enum(["true", "false"]).optional(),
    REAL_MONEY_WITHDRAWAL_CONTROLS_READY: z.enum(["true", "false"]).optional(),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    OBJECT_STORAGE_ENDPOINT: z.string().optional(),
    OBJECT_STORAGE_REGION: z.string().optional(),
    OBJECT_STORAGE_BUCKET: z.string().optional(),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().optional(),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    OBJECT_STORAGE_PUBLIC_BASE_URL: z.string().optional(),
    PUSHER_APP_ID: z.string().optional(),
    PUSHER_KEY: z.string().optional(),
    PUSHER_SECRET: z.string().optional(),
    PUSHER_CLUSTER: z.string().optional(),
    ONESIGNAL_APP_ID: z.string().optional(),
    ONESIGNAL_REST_API_KEY: z.string().optional(),
    LIVEKIT_URL: z.string().optional(),
    LIVEKIT_API_KEY: z.string().optional(),
    LIVEKIT_API_SECRET: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    SENTRY_ENVIRONMENT: z.string().optional(),
  })
  .passthrough();

const rawEnv = envSchema.parse(process.env);

const nodeEnv = rawEnv.NODE_ENV;
const isProduction = nodeEnv === "production";
const isTest = nodeEnv === "test";
const runtimeDatabaseUrl =
  rawEnv.DATABASE_RUNTIME_URL?.trim()
  || rawEnv.NEON_DATABASE_URL?.trim()
  || rawEnv.DATABASE_URL?.trim()
  || (isTest ? "postgres://test:test@127.0.0.1:5432/test" : null);
const adminDatabaseUrl =
  rawEnv.DATABASE_ADMIN_URL?.trim()
  || rawEnv.NEON_DATABASE_ADMIN_URL?.trim()
  || runtimeDatabaseUrl;
const allowedOrigins = splitCsv(rawEnv.ALLOWED_ORIGINS);
const trustedProxyCidrs = splitCsv(rawEnv.TRUST_PROXY_CIDRS);
const redisCacheUrl = rawEnv.REDIS_CACHE_URL?.trim() || rawEnv.REDIS_URL?.trim() || null;
const redisQueueUrl = rawEnv.REDIS_QUEUE_URL?.trim() || rawEnv.REDIS_URL?.trim() || null;
const rateLimitSecret =
  rawEnv.RATE_LIMIT_SECRET?.trim()
  || rawEnv.SESSION_SECRET?.trim()
  || (isTest ? "test-rate-limit-secret" : null);

const featureFlags = {
  runBackgroundJobs: parseBoolean(rawEnv.RUN_BACKGROUND_JOBS, true),
  rateLimitingEnabled: rawEnv.ENABLE_RATE_LIMITING
    ? rawEnv.ENABLE_RATE_LIMITING === "true"
    : isProduction,
  newRateLimiterEnabled: rawEnv.ENABLE_NEW_RATE_LIMITER
    ? rawEnv.ENABLE_NEW_RATE_LIMITER === "true"
    : isProduction,
  cacheGetOrComputeEnabled: parseBoolean(rawEnv.ENABLE_CACHE_GET_OR_COMPUTE),
  loadSheddingEnabled: rawEnv.ENABLE_LOAD_SHEDDING
    ? rawEnv.ENABLE_LOAD_SHEDDING === "true"
    : false,
  bullmqWebhookProcessingEnabled: parseBoolean(rawEnv.ENABLE_BULLMQ_WEBHOOK_PROCESSING),
  circuitBreakersEnabled: rawEnv.ENABLE_CIRCUIT_BREAKERS
    ? rawEnv.ENABLE_CIRCUIT_BREAKERS === "true"
    : false,
  edgeStrictModeEnabled: parseBoolean(rawEnv.ENABLE_EDGE_STRICT_MODE),
  bloomGuardsMode: parseBloomGuardsMode(rawEnv.BLOOM_GUARDS_MODE),
  cashFeaturesEnabled:
    parseBoolean(rawEnv.CASH_FEATURES_ENABLED)
    && parseBoolean(rawEnv.FEATURE_CASH_FEATURES),
  coinEntryChallengesEnabled: parseBoolean(rawEnv.FEATURE_COIN_ENTRY_CHALLENGES),
  allowTestRoutes: parseBoolean(rawEnv.ALLOW_TEST_ROUTES),
  allowDemoSeeds: parseBoolean(rawEnv.ALLOW_DEMO_SEEDS),
  mockProvidersEnabled: parseBoolean(rawEnv.MOCK_PROVIDERS_ENABLED),
};

const realMoneyReadiness = {
  paymentsLiveMode: parseBoolean(rawEnv.PAYMENTS_LIVE_MODE, true),
  productionApproved: parseBoolean(rawEnv.REAL_MONEY_PRODUCTION_APPROVED),
  legalApproved: parseBoolean(rawEnv.REAL_MONEY_LEGAL_APPROVED),
  kycTaxReady: parseBoolean(rawEnv.REAL_MONEY_KYC_TAX_READY),
  providerSandboxTested: parseBoolean(rawEnv.REAL_MONEY_PROVIDER_SANDBOX_TESTED),
  withdrawalControlsReady: parseBoolean(rawEnv.REAL_MONEY_WITHDRAWAL_CONTROLS_READY),
};

const processRole = process.env.APP_PROCESS_ROLE?.trim()
  || (process.argv[1]?.includes("worker") ? "worker" : "api");

const dbPoolMaxByRole = processRole === "worker" ? 5 : processRole === "migration" ? 2 : 10;

const configErrors: string[] = [];

if (!runtimeDatabaseUrl) {
  configErrors.push("DATABASE_RUNTIME_URL or NEON_DATABASE_URL or DATABASE_URL is required");
}

if (!rawEnv.DESCOPE_PROJECT_ID?.trim() && !isTest) {
  configErrors.push("DESCOPE_PROJECT_ID is required");
}

if (featureFlags.rateLimitingEnabled && !redisCacheUrl) {
  configErrors.push("REDIS_CACHE_URL or REDIS_URL is required when ENABLE_RATE_LIMITING=true");
}

if (featureFlags.rateLimitingEnabled && !rateLimitSecret) {
  configErrors.push("RATE_LIMIT_SECRET or SESSION_SECRET is required when ENABLE_RATE_LIMITING=true");
}

if (featureFlags.bullmqWebhookProcessingEnabled && !redisQueueUrl) {
  configErrors.push("REDIS_QUEUE_URL or REDIS_URL is required when ENABLE_BULLMQ_WEBHOOK_PROCESSING=true");
}

if (isProduction) {
  if (!rawEnv.APP_BASE_URL?.trim()) {
    configErrors.push("APP_BASE_URL is required in production");
  } else if (!rawEnv.APP_BASE_URL.startsWith("https://")) {
    configErrors.push("APP_BASE_URL must use https:// in production");
  }

  if (allowedOrigins.length === 0) {
    configErrors.push("ALLOWED_ORIGINS must contain at least one origin in production");
  }

  if (featureFlags.allowTestRoutes) {
    configErrors.push("ALLOW_TEST_ROUTES must be false in production");
  }

  if (featureFlags.allowDemoSeeds) {
    configErrors.push("ALLOW_DEMO_SEEDS must be false in production");
  }

  if (featureFlags.mockProvidersEnabled) {
    configErrors.push("MOCK_PROVIDERS_ENABLED must be false in production");
  }

  if (["debug", "trace"].includes(rawEnv.LOG_LEVEL.toLowerCase())) {
    configErrors.push("LOG_LEVEL must not be debug or trace in production");
  }

  if (!rawEnv.OBJECT_STORAGE_ENDPOINT?.trim()) {
    configErrors.push("OBJECT_STORAGE_ENDPOINT is required in production");
  }

  if (!rawEnv.OBJECT_STORAGE_BUCKET?.trim()) {
    configErrors.push("OBJECT_STORAGE_BUCKET is required in production");
  }

  if (!rawEnv.OBJECT_STORAGE_ACCESS_KEY_ID?.trim()) {
    configErrors.push("OBJECT_STORAGE_ACCESS_KEY_ID is required in production");
  }

  if (!rawEnv.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim()) {
    configErrors.push("OBJECT_STORAGE_SECRET_ACCESS_KEY is required in production");
  }

  if (!rawEnv.OBJECT_STORAGE_PUBLIC_BASE_URL?.trim()) {
    configErrors.push("OBJECT_STORAGE_PUBLIC_BASE_URL is required in production");
  } else if (!rawEnv.OBJECT_STORAGE_PUBLIC_BASE_URL.startsWith("https://")) {
    configErrors.push("OBJECT_STORAGE_PUBLIC_BASE_URL must use https:// in production");
  }

  if (featureFlags.cashFeaturesEnabled) {
    if (realMoneyReadiness.paymentsLiveMode && !realMoneyReadiness.productionApproved) {
      configErrors.push("REAL_MONEY_PRODUCTION_APPROVED=true is required when cash features are enabled in production");
    }
    if (realMoneyReadiness.paymentsLiveMode && !realMoneyReadiness.legalApproved) {
      configErrors.push("REAL_MONEY_LEGAL_APPROVED=true is required when cash features are enabled in production");
    }
    if (realMoneyReadiness.paymentsLiveMode && !realMoneyReadiness.kycTaxReady) {
      configErrors.push("REAL_MONEY_KYC_TAX_READY=true is required when cash features are enabled in production");
    }
    if (realMoneyReadiness.paymentsLiveMode && !realMoneyReadiness.providerSandboxTested) {
      configErrors.push("REAL_MONEY_PROVIDER_SANDBOX_TESTED=true is required when cash features are enabled in production");
    }
    if (realMoneyReadiness.paymentsLiveMode && !realMoneyReadiness.withdrawalControlsReady) {
      configErrors.push("REAL_MONEY_WITHDRAWAL_CONTROLS_READY=true is required when cash features are enabled in production");
    }
    if (!featureFlags.bullmqWebhookProcessingEnabled) {
      configErrors.push("ENABLE_BULLMQ_WEBHOOK_PROCESSING=true is required when cash features are enabled in production");
    }
    if (!featureFlags.runBackgroundJobs) {
      configErrors.push("RUN_BACKGROUND_JOBS=true is required when cash features are enabled in production");
    }
    if (!rawEnv.STRIPE_WEBHOOK_SECRET?.trim()) {
      configErrors.push("STRIPE_WEBHOOK_SECRET is required when cash features are enabled in production");
    }
    if (!rawEnv.RAZORPAY_WEBHOOK_SECRET?.trim()) {
      configErrors.push("RAZORPAY_WEBHOOK_SECRET is required when cash features are enabled in production");
    }
  }
}

if (configErrors.length > 0) {
  throw new Error(`Invalid runtime configuration:\n- ${configErrors.join("\n- ")}`);
}

export const config = {
  nodeEnv,
  isProduction,
  port: rawEnv.PORT,
  logLevel: rawEnv.LOG_LEVEL,
  appBaseUrl: rawEnv.APP_BASE_URL?.replace(/\/$/, "") ?? null,
  allowedOrigins,
  trustProxy: trustedProxyCidrs.length > 0
    ? trustedProxyCidrs
    : isProduction
      ? rawEnv.TRUST_PROXY_HOPS ?? 1
      : false,
  trustedProxyCidrs,
  features: featureFlags,
  realMoneyReadiness,
  processRole,
  runtime: {
    requestTimeoutMs: 15_000,
    responseTimeoutMs: 20_000,
    uploadTimeoutMs: 30_000,
    mediaProxyTimeoutMs: 12_000,
    mediaProxyUpstreamTimeoutMs: 8_000,
    redisCommandTimeoutMs: 2_000,
    queueEnqueueTimeoutMs: 2_000,
    jsonBodyLimit: "2mb",
    urlencodedBodyLimit: "1mb",
    uploadBodyLimitBytes: 5 * 1024 * 1024,
    themeImageBodyLimitBytes: 10 * 1024 * 1024,
    maxJsonDepth: 8,
    maxJsonArrayItems: 200,
    maxJsonStringLength: 20_000,
    maxJsonObjectKeys: 200,
    maxPaginationLimit: 100,
    maxSearchQueryLength: 64,
    maxCollectionSize: 50,
  },
  database: {
    runtimeUrl: runtimeDatabaseUrl!,
    adminUrl: adminDatabaseUrl!,
    poolMax: dbPoolMaxByRole,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statementTimeoutMillis: 15_000,
    idleInTransactionSessionTimeoutMillis: 30_000,
    totalExpectedSteadyStateMaxConnections: 17,
  },
  redis: {
    url: redisCacheUrl,
    cacheUrl: redisCacheUrl,
    queueUrl: redisQueueUrl,
    splitConfigured: Boolean(redisCacheUrl && redisQueueUrl && redisCacheUrl !== redisQueueUrl),
  },
  health: {
    readinessDetailToken: rawEnv.READINESS_DETAIL_TOKEN?.trim() ?? null,
  },
  rateLimit: {
    secret: rateLimitSecret,
  },
  auth: {
    descopeProjectId: rawEnv.DESCOPE_PROJECT_ID?.trim() ?? (isTest ? "test-project" : null),
    descopeManagementKey: rawEnv.DESCOPE_MANAGEMENT_KEY?.trim() ?? null,
  },
  payments: {
    stripeSecretKey: rawEnv.STRIPE_SECRET_KEY?.trim() ?? null,
    stripeWebhookSecret: rawEnv.STRIPE_WEBHOOK_SECRET?.trim() ?? null,
    razorpayKeyId: rawEnv.RAZORPAY_KEY_ID?.trim() ?? null,
    razorpayKeySecret: rawEnv.RAZORPAY_KEY_SECRET?.trim() ?? null,
    razorpayWebhookSecret: rawEnv.RAZORPAY_WEBHOOK_SECRET?.trim() ?? null,
  },
  objectStorage: {
    endpoint: rawEnv.OBJECT_STORAGE_ENDPOINT?.trim() ?? null,
    region: rawEnv.OBJECT_STORAGE_REGION?.trim() || "auto",
    bucket: rawEnv.OBJECT_STORAGE_BUCKET?.trim() ?? null,
    accessKeyId: rawEnv.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() ?? null,
    secretAccessKey: rawEnv.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() ?? null,
    publicBaseUrl: rawEnv.OBJECT_STORAGE_PUBLIC_BASE_URL?.trim().replace(/\/$/, "") ?? null,
  },
  providers: {
    pusherConfigured: Boolean(
      rawEnv.PUSHER_APP_ID?.trim()
      && rawEnv.PUSHER_KEY?.trim()
      && rawEnv.PUSHER_SECRET?.trim()
      && rawEnv.PUSHER_CLUSTER?.trim(),
    ),
    oneSignalConfigured: Boolean(
      rawEnv.ONESIGNAL_APP_ID?.trim() && rawEnv.ONESIGNAL_REST_API_KEY?.trim(),
    ),
    livekitConfigured: Boolean(
      rawEnv.LIVEKIT_URL?.trim()
      && rawEnv.LIVEKIT_API_KEY?.trim()
      && rawEnv.LIVEKIT_API_SECRET?.trim(),
    ),
  },
  sentry: {
    dsn: rawEnv.SENTRY_DSN?.trim() ?? null,
    environment: rawEnv.SENTRY_ENVIRONMENT?.trim() ?? nodeEnv,
  },
} as const;

export type AppConfig = typeof config;
