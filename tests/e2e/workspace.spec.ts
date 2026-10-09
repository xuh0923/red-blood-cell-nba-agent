import { expect, test } from "@playwright/test";

test("desktop workflow reaches an analysis result", async ({ page }) => {
  const trackingFixture = {
    version: "1.0",
    video: { width: 1920, height: 1080, durationSeconds: 2, sourceFps: 60, processedFps: 10 },
    model: { name: "test-model", device: "cpu", imageSize: 640 },
    frames: [{ atSeconds: 0, players: [{
      trackId: 7, label: "球员 07", role: "player", team: "team-a", confidence: 0.9, identityConfidence: 0, identitySource: "unconfirmed",
      box: { x: 0.2, y: 0.2, width: 0.1, height: 0.3 }
    }] }],
    tracks: [{ trackId: 7, label: "球员 07", role: "player", team: "team-a", firstSeen: 0, lastSeen: 0, observations: 1, identityConfidence: 0, identitySource: "unconfirmed" }],
    roster: {
      gameId: "test-game", sourceFile: "roster.json", teamCodes: ["DAL", "HOU"], playerCount: 2,
      players: [{ teamCode: "DAL", playerId: "d1", name: "Player One", jerseyNumber: "7" }, { teamCode: "HOU", playerId: "h1", name: "Player Two", jerseyNumber: "1" }]
    },
    warnings: ["测试轨迹"]
  };
  await page.route("**/local-api/jobs", async (route) => {
    await route.fulfill({ json: { id: "local-test", status: "queued", progress: 5 } });
  });
  await page.route("**/local-api/jobs/local-test", async (route) => {
    await route.fulfill({ json: { id: "local-test", status: "completed", progress: 100 } });
  });
  await page.route("**/local-api/jobs/local-test/tracking", async (route) => {
    await route.fulfill({ json: trackingFixture });
  });
  await page.route("**/local-api/jobs/local-test/identities", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ json: {
      ...trackingFixture,
      frames: [{ ...trackingFixture.frames[0], players: [{ ...trackingFixture.frames[0]!.players[0], label: "Player One", playerId: "d1", playerName: "Player One", jerseyNumber: "7", identityConfidence: 1, identitySource: "manual" }] }],
      tracks: [{ ...trackingFixture.tracks[0], label: "Player One", playerId: "d1", playerName: "Player One", jerseyNumber: "7", identityConfidence: 1, identitySource: "manual" }]
    } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?workspace=1");
  await expect(page.getByRole("heading", { name: "把一个回合，讲得明白。" })).toBeVisible();

  await page.getByLabel("比赛视频").setInputFiles({
    name: "training-clip.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("video-fixture")
  });
  await page.getByLabel("深度数据 JSON 或 CSV").setInputFiles({
    name: "metrics.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ expectedFieldGoalPercentage: 0.47, onBallGravity: 1.71, winImpact: 3.1 }))
  });
  await page.getByRole("button", { name: "开始连续识别" }).click();

  await expect(page.getByText("ANALYSIS COMPLETE")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("47%").first()).toBeVisible();
  await expect(page.getByText("1.71").first()).toBeVisible();
  await expect(page.getByText("+3.1").first()).toBeVisible();
  await expect(page.getByText("1 条球员轨迹", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "身份" }).click();
  await page.getByLabel("确认轨迹 7 的球员身份").selectOption("d1");
  await expect(page.getByText("已确认")).toBeVisible();
  await expect(page.getByLabel("连续球员跟踪").getByText("Player One")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tmp/result-desktop.png", fullPage: true });
});

test("roster upload is available without blocking local tracking", async ({ page }) => {
  await page.goto("/?workspace=1");
  await page.getByLabel("比赛名单 JSON").setInputFiles({
    name: "game-roster.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      version: "1.0",
      gameId: "test-game",
      teams: [
        { teamCode: "DAL", teamName: "Dallas", players: [{ playerId: "d1", name: "Player One", jerseyNumber: "7" }] },
        { teamCode: "HOU", teamName: "Houston", players: [{ playerId: "h1", name: "Player Two", jerseyNumber: "1" }] }
      ]
    }))
  });
  await expect(page.getByText("game-roster.json")).toBeVisible();
  await expect(page.getByText("不会将轨迹编号映射为球员姓名")).toHaveCount(0);
});

test("mobile workspace has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?workspace=1");
  await expect(page.getByRole("heading", { name: "把一个回合，讲得明白。" })).toBeVisible();
  await expect(page.getByText("分析工作台").last()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "tmp/home-mobile.png", fullPage: true });
});

test("review link opens a pre-generated Team28 work without an upload prompt", async ({ page }) => {
  const tracking = {
    version: "1.0",
    video: { width: 1920, height: 1080, durationSeconds: 2, sourceFps: 60, processedFps: 10 },
    model: { name: "test-model", device: "cpu", imageSize: 640 },
    frames: [], tracks: [], warnings: []
  };
  const analysis = {
    version: "1.0", generatedBy: "local-rules", summary: "预生成结果", warnings: [],
    provenance: { videoFile: "featured.mp4", dataFile: "metrics.json" }, events: [], narration: []
  };
  await page.route("**/showcase/manifest.json", async (route) => {
    await route.fulfill({ json: { version: "1.0", teamId: "Team28", title: "预生成作品", videoUrl: "featured.mp4", analysisUrl: "analysis.json", trackingUrl: "tracking.json" } });
  });
  await page.route("**/showcase/analysis.json", async (route) => { await route.fulfill({ json: analysis }); });
  await page.route("**/showcase/tracking.json", async (route) => { await route.fulfill({ json: tracking }); });
  await page.goto("/");
  await expect(page.getByText("TEAM28 · REVIEW RESULT")).toBeVisible();
  await expect(page.getByText("红细胞队 · Team28", { exact: true })).toBeVisible();
  await expect(page.getByLabel("比赛视频")).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("button", { name: "新建分析" })).toBeVisible();
});
