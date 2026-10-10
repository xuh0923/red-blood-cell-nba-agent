import { describe, expect, it } from "vitest";
import { analysisContextSchema, analysisSchema, gameRosterSchema, gameStatsTimelineSchema, metricDisplay, trackingResultSchema } from "./index.js";
import { demoAnalysis } from "./fixtures.js";

describe("shared contracts", () => {
  it("accepts the demo analysis", () => {
    expect(analysisSchema.parse(demoAnalysis).events).toHaveLength(3);
  });

  it("formats metrics by unit", () => {
    expect(metricDisplay(demoAnalysis.events[1]!.metric)).toBe("42%");
    expect(metricDisplay(demoAnalysis.events[2]!.metric)).toBe("+2.7");
  });

  it("requires auditable evidence for analysis context metrics", () => {
    const context = analysisContextSchema.parse({
      version: "1.0",
      video: { durationSeconds: 12 },
      windows: [{
        id: "play-1",
        startSeconds: 2,
        endSeconds: 4,
        metrics: [{ name: "xFG", value: 0.42, unit: "ratio", evidence: [{ kind: "data", source: "shots.csv", locator: "row:18" }] }],
        evidence: [{ kind: "frame", source: "frames/frame-01.jpg", locator: "time:2.1", atSeconds: 2.1 }]
      }],
      warnings: []
    });
    expect(context.windows[0]?.metrics[0]?.evidence[0]?.locator).toBe("row:18");
    expect(analysisContextSchema.safeParse({ ...context, windows: [{ ...context.windows[0], metrics: [{ ...context.windows[0]!.metrics[0], evidence: [] }] }] }).success).toBe(false);
  });

  it("rejects frame timestamps outside the video", async () => {
    const { createJobRequestSchema } = await import("./index.js");
    const parsed = createJobRequestSchema.safeParse({
      videoFileName: "clip.mp4",
      videoContentType: "video/mp4",
      inputDigest: `sha256:${"a".repeat(64)}`,
      dataFileName: "data.json",
      dataContentType: "application/json",
      videoDurationSeconds: 10,
      frameTimestamps: [2, 5, 12]
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a bounded video size for multipart upload planning", async () => {
    const { createJobRequestSchema } = await import("./index.js");
    const parsed = createJobRequestSchema.parse({
      videoFileName: "clip.mp4",
      videoContentType: "video/mp4",
      videoSizeBytes: 84 * 1024 * 1024,
      inputDigest: `sha256:${"a".repeat(64)}`,
      dataFileName: "data.json",
      dataContentType: "application/json",
      videoDurationSeconds: 20,
      frameTimestamps: [2, 8, 14]
    });
    expect(parsed.videoSizeBytes).toBe(84 * 1024 * 1024);
  });

  it("accepts normalized continuous player observations", () => {
    const parsed = trackingResultSchema.parse({
      version: "1.0",
      video: { width: 1920, height: 1080, durationSeconds: 22, sourceFps: 60, processedFps: 10 },
      model: { name: "yolo11n.pt", device: "cpu", imageSize: 640 },
      quality: { frameCoverage: 0.94, ballFrameCoverage: 0.4, meanPlayerConfidence: 0.81, trackCount: 10 },
      frames: [{
        atSeconds: 1.2,
        players: [{
          trackId: 7,
          label: "球员 07",
          role: "player",
          team: "team-a",
          confidence: 0.91,
          identityConfidence: 0,
          box: { x: 0.2, y: 0.1, width: 0.08, height: 0.31 }
        }]
      }],
      tracks: [{
        trackId: 7,
        label: "球员 07",
        role: "player",
        team: "team-a",
        firstSeen: 1.2,
        lastSeen: 1.2,
        observations: 1,
        identityConfidence: 0
      }],
      warnings: []
    });
    expect(parsed.frames[0]?.players[0]?.trackId).toBe(7);
    expect(parsed.quality?.trackCount).toBe(10);
  });

  it("requires a unique jersey number within each team roster", () => {
    const valid = {
      version: "1.0",
      gameId: "test-game",
      teams: [
        { teamCode: "DAL", teamName: "Dallas", players: [{ playerId: "d1", name: "Player One", jerseyNumber: "7" }] },
        { teamCode: "HOU", teamName: "Houston", players: [{ playerId: "h1", name: "Player Two", jerseyNumber: "7" }] }
      ]
    };
    expect(gameRosterSchema.parse(valid).teams).toHaveLength(2);
    expect(gameRosterSchema.safeParse({
      ...valid,
      teams: [{ ...valid.teams[0], players: [...valid.teams[0].players, { playerId: "d2", name: "Player Three", jerseyNumber: "7" }] }, valid.teams[1]]
    }).success).toBe(false);
    expect(gameRosterSchema.safeParse({
      ...valid,
      teams: [valid.teams[0], { ...valid.teams[1], players: [{ ...valid.teams[1].players[0], playerId: "d1" }] }]
    }).success).toBe(false);
  });

  it("accepts time-sorted basketball stat snapshots and rejects impossible shooting", () => {
    const timeline = {
      version: "1.0",
      gameId: "dal-hou-demo",
      source: "official box score",
      snapshots: [
        { atSeconds: 0, period: 4, clock: "02:00", teams: [{ teamCode: "DAL", score: 101, fieldGoals: { made: 37, attempted: 80 } }, { teamCode: "HOU", score: 105, fieldGoals: { made: 40, attempted: 84 } }] },
        { atSeconds: 8, period: 4, clock: "01:52", teams: [{ teamCode: "DAL", score: 103, fieldGoals: { made: 38, attempted: 81 } }, { teamCode: "HOU", score: 107, fieldGoals: { made: 41, attempted: 85 } }] }
      ]
    };
    expect(gameStatsTimelineSchema.parse(timeline).snapshots).toHaveLength(2);
    expect(gameStatsTimelineSchema.safeParse({
      ...timeline,
      snapshots: [{ ...timeline.snapshots[0], teams: [{ teamCode: "DAL", score: 1, fieldGoals: { made: 3, attempted: 2 } }, timeline.snapshots[0].teams[1]] }]
    }).success).toBe(false);
  });
});
