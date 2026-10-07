import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Integration files share one Postgres and truncate it in beforeEach, so
    // files must not run in parallel (pool-level option).
    fileParallelism: false,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          // Real Postgres (TEST_DATABASE_URL); external HTTP is mocked by msw.
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "app"),
    },
  },
});
