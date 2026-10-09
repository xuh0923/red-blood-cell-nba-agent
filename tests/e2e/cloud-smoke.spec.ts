import { expect, test } from "@playwright/test";

const videoPath = process.env.COURTVISION_VIDEO;

test("deployed AgentCore analyzes real training footage", async ({ page }) => {
  test.skip(!process.env.COURTVISION_E2E_URL || !videoPath, "cloud URL and training video are required");
  test.setTimeout(15 * 60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "AgentCore" })).toBeEnabled();

  await page.locator('input[accept^="video/"]').setInputFiles(videoPath!);
  await page.locator('input[accept^=".json"]').setInputFiles({
    name: "training-metrics.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      expectedFieldGoalPercentage: 0.47,
      onBallGravity: 1.71,
      winImpact: 3.1,
      source: "cloud smoke test values"
    }))
  });
  await page.getByRole("button", { name: "开始智能识别" }).click();

  let completed = false;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await page.getByText("ANALYSIS COMPLETE").isVisible()) {
      completed = true;
      break;
    }
    const error = page.locator(".error-text");
    if (await error.isVisible()) throw new Error(`UI workflow failed: ${await error.textContent()}`);
    if (attempt % 5 === 0) {
      const state = await page.locator(".progress-copy").textContent().catch(() => "no progress state");
      console.log(`cloud workflow: ${state}`);
    }
    await page.waitForTimeout(3000);
  }
  expect(completed, "cloud analysis did not finish before the deadline").toBe(true);
  await expect(page.getByText("AgentCore 多模态结果")).toBeVisible();
  await expect(page.getByText("Agent 读取的关键帧")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tmp/cloud-result.png", fullPage: true });
});
