import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers.x-api-key",
    "req.headers.x-admin-key",
    "req.headers.x-service-key",
    "res.headers['set-cookie']",
    "body.password",
    "body.token",
    "body.refreshToken",
    "body.accessToken",
    "body.secret",
    "body.adminKey",
    "body.serviceKey",
    "body.cardNumber",
    "body.cvv",
    "body.clientSecret",
    "body.fulfillmentCode",
    "*.authorization",
    "*.cookie",
    "*.secret",
    "*.token",
    "*.refreshToken",
    "*.accessToken",
    "*.fulfillmentCode",
  ],
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
