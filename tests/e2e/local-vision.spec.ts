import { expect, test } from "@playwright/test";

const videoPath = process.env.COURTVISION_LOCAL_VIDEO;

test("local vision tracks players in real footage", async ({ page }) => {
  test.skip(!videoPath, "COURTVISION_LOCAL_VIDEO is required for the real vision test");
  test.setTimeout(3 * 60_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByLabel("比赛视频").setInputFiles(videoPath!);
  await page.getByRole("button", { name: "开始连续识别" }).click();
  await expect(page.getByText("ANALYSIS COMPLETE")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".tracking-status")).toBeVisible();
  await expect(page.getByText(/^\d+ 条球员轨迹$/)).toBeVisible();
  await page.locator("video").evaluate((video: HTMLVideoElement) => {
    video.currentTime = 5;
    return video.play();
  });
  await expect(page.locator(".player-track").first()).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tmp/local-vision-result.png", fullPage: true });
});
