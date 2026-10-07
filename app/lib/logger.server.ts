import pino from "pino";

/**
 * Redaction paths: never log tokens, secrets, emails, or raw payloads.
 * Values matching these top-level keys are replaced with "[Redacted]".
 */
const redactPaths = [
  "accessToken",
  "refreshToken",
  "password",
  "secret",
  "apiSecret",
  "apiKey",
  "token",
  "clientSecret",
  "hmac",
  "email",
  "payload",
  "rawBody",
  "body",
  "headers.authorization",
  "headers.Authorization",
  "headers['x-shopify-hmac-sha256']",
  "headers['X-Shopify-Hmac-Sha256']",
  "headers['x-telegram-bot-api-secret-token']",
  "headers['svix-signature']",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.token",
  "*.hmac",
  "*.email",
  "*.payload",
  "session.accessToken",
  "settings.*.chat_id_enc",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: redactPaths, censor: "[Redacted]" },
  base: undefined,
});

export default logger;
