import { defineConfig } from "@playwright/test";

const remoteUrl = process.env.COURTVISION_E2E_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 20_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    baseURL: remoteUrl ?? "http://127.0.0.1:5173",
    channel: "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: remoteUrl ? undefined : {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30_000
  }
});
