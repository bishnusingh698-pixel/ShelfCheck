import express from "express";
import { createRequestHandler } from "@react-router/express";
import { existsSync } from "node:fs";
import path from "node:path";
import { startWorker, stopWorker } from "./worker.js";
import { db } from "../app/db.server.js";
import { logger } from "../app/lib/logger.server.js";
import { env } from "../app/env.server.js";

const port = Number(process.env.PORT || 3000);
const app = express();

app.disable("x-powered-by");

// --- Raw body capture before any JSON parsing (webhook HMAC + Resend Svix verification) ---
type RawReq = express.Request & { rawBody?: Buffer };
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as RawReq).rawBody = buf;
    },
  }),
);

// --- Security headers ---
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
  );
  next();
});

// --- Health check (plain Express, no framework overhead) ---
app.get("/healthz", async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.status(200).json({ db: "ok" });
  } catch {
    res.status(503).json({ db: "unavailable" });
  }
});

// --- React Router handler for everything else ---
const buildPath = path.resolve("build/server/index.js");
if (!existsSync(buildPath)) {
  logger.error({ buildPath }, "React Router server build not found; run `npm run build` first");
  process.exit(1);
}
const build = await import(buildPath);

const handler = createRequestHandler({
  build: build as never,
  mode: process.env.NODE_ENV === "production" ? "production" : "development",
});
app.all("*any", (req, res, next) => {
  void handler(req, res, next);
});

const server = app.listen(port, () => {
  logger.info({ port, nodeEnv: process.env.NODE_ENV }, "shelfcheck http server listening");
});

// --- Worker (drains jobs while the instance is awake; correctness never depends on it) ---
const worker = startWorker({ logger, intervalMs: 2000, maxDrainMs: 1500 });

// --- SIGTERM: stop claiming, drain current job, close DB, exit ---
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), 30_000);
  forceExit.unref();
  server.close();
  await stopWorker(worker, { drainMs: 10_000 });
  await db.$disconnect();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
