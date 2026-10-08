import { test, expect, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Dashboard + onboarding e2e against the UI harness (spec <ui_spec>, Phase 8
 * gate: "Playwright and axe pass for these screens in en and en-XA").
 *
 * The project name picks the locale: the en-XA project navigates with
 * ?locale=en-XA, which loads the generated pseudo catalog (accented, ~33%
 * longer) — it catches hardcoded strings (missing-key markers) and layout
 * overflow. English-string assertions run in the en project only.
 * `?fixture=onboarding` selects the fresh-install fixture shop.
 */

const KEY_MARKER = /\b(app|nav|common|issue|dashboard|scan|settings|rules|plans|toast|csv|email)\.[a-z][a-z]/i;
const ACCENTED = /[áéíóúñçÁÉÍÓÚÑÇ]/;

const pseudo = (testInfo: TestInfo) => testInfo.project.name === "en-XA";

function path(extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  return params.size > 0 ? `/app?${params}` : "/app";
}

async function open(page: Page, testInfo: TestInfo, extra?: Record<string, string>) {
  const all = { ...(pseudo(testInfo) ? { locale: "en-XA" } : {}), ...extra };
  await page.goto(path(all));
  // Server-rendered heading proves the screen is never blank.
  await expect(page.getByRole("heading").first()).toBeVisible();
}

test("dashboard shows health score, scan status, plan usage, and counts", async ({ page }, testInfo) => {
  test.skip(pseudo(testInfo), "English string assertions run in the en project");
  await open(page, testInfo);

  // Seeded fixture shop: latest completed scan has score 72.
  await expect(page.getByText("72", { exact: true })).toBeVisible();
  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Last scan" })).toBeVisible();
  await expect(page.getByText(/last scanned/i)).toBeVisible();

  // Plan usage: 4821 variants analyzed against the 5000 starter cap.
  await expect(page.getByText(/4,821 of 5,000/i)).toBeVisible();

  // Severity counts link to the filtered issue list.
  await expect(page.getByRole("link", { name: "High" })).toHaveAttribute(
    "href",
    "/app/issues?severity=high",
  );

  // Last completed scan is 2 days old (past cooldown, none today):
  // Scan now is offered.
  await expect(page.getByRole("button", { name: "Scan now" })).toBeVisible();
});

test("trend lists the last 8 scans with new and resolved counts", async ({ page }, testInfo) => {
  test.skip(pseudo(testInfo), "English string assertions run in the en project");
  await open(page, testInfo);
  await expect(page.getByRole("heading", { name: "New vs resolved" })).toBeVisible();
  await expect(page.getByText("Last 8 scans")).toBeVisible();
  // Oldest first: "Scan 1" .. "Scan 8".
  await expect(page.getByText("Scan 1")).toBeVisible();
  await expect(page.getByText("Scan 8")).toBeVisible();
});

test("onboarding checklist shows for a fresh install — never a blank screen", async ({ page }, testInfo) => {
  test.skip(pseudo(testInfo), "English string assertions run in the en project");
  await open(page, testInfo, { fixture: "onboarding" });

  await expect(page.getByRole("heading", { name: "Set up ShelfCheck" })).toBeVisible();
  // The install scan is queued, so the first step shows live progress.
  await expect(page.getByText("First scan running")).toBeVisible();
  await expect(page.getByText("Review your issues")).toBeVisible();
  await expect(page.getByText("Set up the weekly digest")).toBeVisible();
  // No health score yet: no completed scan.
  await expect(page.getByText("Health score")).not.toBeVisible();
});

test("every string is translated — no missing-key markers", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(KEY_MARKER);
  expect(text.trim().length).toBeGreaterThan(0);

  // The right catalog actually loaded for this project's locale.
  if (pseudo(testInfo)) {
    expect(text).toMatch(ACCENTED);
  } else {
    expect(text).not.toMatch(ACCENTED);
  }
});

test("dashboard has no axe violations (wcag2aa)", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("onboarding has no axe violations (wcag2aa)", async ({ page }, testInfo) => {
  await open(page, testInfo, { fixture: "onboarding" });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("no horizontal overflow at 375px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await open(page, testInfo);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("no horizontal overflow at 1280px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page, testInfo);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
