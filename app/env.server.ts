import { z } from "zod";

const boolish = z
  .union([z.string(), z.boolean()])
  .transform((v) => (typeof v === "boolean" ? v : v === "1" || v.toLowerCase() === "true"));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // --- Shopify (from `shopify app env` / Partner Dashboard) ---
  SHOPIFY_API_KEY: z.string().default(""),
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_APP_URL: z.string().default("http://localhost:3000"),
  SHOPIFY_APP_HANDLE: z.string().default("shelfcheck"),
  SCOPES: z.string().default("read_products,read_inventory"),
  SHOP_CUSTOM_DOMAIN: z.string().optional(),

  // --- Database (Neon: pooled at runtime, direct for migrations) ---
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),

  // --- Security keys ---
  /** AES-256 key material for token/chat-id encryption. Hex or base64; >= 32 bytes. Format: `v1:<key>`. */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^v1:[A-Za-z0-9+/=_-]{43,}$/, "ENCRYPTION_KEY must look like v1:<43+ chars of key material>"),
  /** Dedicated HMAC key for signed tokens (unsubscribe, telegram link). Same format. */
  SIGNING_KEY: z
    .string()
    .regex(/^v1:[A-Za-z0-9+/=_-]{43,}$/, "SIGNING_KEY must look like v1:<43+ chars of key material>"),
  /** Shared secret required by POST /jobs/tick. */
  TICK_SECRET: z.string().min(16).default("dev-only-tick-secret-not-for-production"),

  // --- Resend (digest email) ---
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  RESEND_FROM: z.string().default("ShelfCheck <digest@example.invalid>"),
  RESEND_DAILY_LIMIT: z.coerce.number().int().positive().default(100),
  RESEND_MONTHLY_LIMIT: z.coerce.number().int().positive().default(3000),

  // --- Telegram (Pro alerts) ---
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // --- App identity ---
  APP_URL: z.string().default("http://localhost:3000"),

  // --- Test-only flags ---
  UI_HARNESS: boolish.default(false),
  TEST_DATABASE_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const env = parseEnv(process.env);
  if (env.NODE_ENV === "production") {
    if (env.TICK_SECRET === "dev-only-tick-secret-not-for-production") {
      throw new Error("TICK_SECRET must be changed in production");
    }
    if (env.UI_HARNESS) {
      throw new Error("UI_HARNESS must never be enabled in production");
    }
    if (!env.SHOPIFY_API_KEY || !env.SHOPIFY_API_SECRET) {
      throw new Error("SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required in production");
    }
  }
  cached = env;
  return env;
}

export const env = getEnv();
