import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: "line",
  outputDir: "test-results/playwright",
  use: {
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/server.mjs",
    url: "http://127.0.0.1:4173/static-article.html",
    reuseExistingServer: false,
    timeout: 10_000,
  },
});
