import { expect, test } from "@playwright/test";

const videoPath = process.env.COURTVISION_CLOUD_VIDEO;

test("AWS upload, vision, transcode, and CloudFront playback", async ({ page }) => {
  test.skip(!videoPath, "Set COURTVISION_CLOUD_VIDEO to run the real AWS smoke test");
  test.setTimeout(60 * 60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?workspace=1");
  await page.getByRole("button", { name: "AWS 托管处理" }).click();
  await page.getByLabel("比赛视频").setInputFiles(videoPath!);
  await page.getByLabel("比赛资料 JSON 或 CSV").setInputFiles({
    name: "cloud-smoke-data.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ expectedFieldGoalPercentage: 0.47, onBallGravity: 1.31 }))
  });
  const startedAt = Date.now();
  await page.getByRole("button", { name: "开始连续识别" }).click();
  await expect(page.getByText("ANALYSIS COMPLETE")).toBeVisible({ timeout: 55 * 60_000 });
  const source = await page.locator("video").getAttribute("src");
  expect(source).toContain("/media/");
  expect(source).toContain("-1080p.mp4");
  await expect(page.locator(".result-footer").getByText(/AWS 托管/)).toBeVisible();
  console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), source }));
});
