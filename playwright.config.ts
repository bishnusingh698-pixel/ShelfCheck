import { defineConfig, devices } from "@playwright/test";

/**
 * One project per locale (spec <file_layout>: playwright.config.ts), running
 * against the UI harness: a real build of the app served with
 * NODE_ENV=test + UI_HARNESS=1, backed by the test database seeded with a
 * fixture shop. The harness skips App Bridge (which cannot run outside the
 * Shopify admin iframe) but exercises the real loaders and components.
 *
 * en — the real strings.
 * en-XA — the generated pseudo locale: catches hardcoded strings and layout
 *         overflow when text grows ~30%.
 */

const PORT = Number(process.env.E2E_PORT || 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: {
    // Pseudo-locale strings and dynamic content shift between renders.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "en",
      use: {
        ...devices["Desktop Chrome"],
        locale: "en",
        extraHTTPHeaders: { "accept-language": "en" },
      },
    },
    {
      name: "en-XA",
      use: {
        ...devices["Desktop Chrome"],
        locale: "en-XA",
        extraHTTPHeaders: { "accept-language": "en-XA" },
      },
    },
  ],
  webServer: {
    // The pseudo catalog is generated (never committed), then the real
    // production server (Express entry) is built and started against the test
    // database with the harness active. SHOPIFY_* are dummy values: the harness
    // never calls Shopify, and the in-process job worker stays off.
    command: `npm run i18n:pseudo && npm run build && PORT=${PORT} NODE_ENV=test UI_HARNESS=1 SHOPIFY_API_KEY=test-api-key SHOPIFY_API_SECRET=test-api-secret SHOPIFY_APP_URL=${BASE_URL} DATABASE_URL="\${TEST_DATABASE_URL:-$DATABASE_URL}" npm run start`,
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
