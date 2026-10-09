import { describe, expect, it } from "vitest";
import { analysisSchema, deviceEventSchema, gameRosterSchema, metricDisplay, trackingResultSchema } from "./index.js";
import { demoAnalysis } from "./fixtures.js";

describe("shared contracts", () => {
  it("accepts the demo analysis", () => {
    expect(analysisSchema.parse(demoAnalysis).events).toHaveLength(3);
  });

  it("formats metrics by unit", () => {
    expect(metricDisplay(demoAnalysis.events[1]!.metric)).toBe("42%");
    expect(metricDisplay(demoAnalysis.events[2]!.metric)).toBe("+2.7");
  });

  it("rejects a device message without ordering metadata", () => {
    expect(() => deviceEventSchema.parse({ type: "status", version: 1 })).toThrow();
  });

  it("rejects frame timestamps outside the video", async () => {
    const { createJobRequestSchema } = await import("./index.js");
    const parsed = createJobRequestSchema.safeParse({
      videoFileName: "clip.mp4",
      videoContentType: "video/mp4",
      dataFileName: "data.json",
      dataContentType: "application/json",
      videoDurationSeconds: 10,
      frameTimestamps: [2, 5, 12]
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts normalized continuous player observations", () => {
    const parsed = trackingResultSchema.parse({
      version: "1.0",
      video: { width: 1920, height: 1080, durationSeconds: 22, sourceFps: 60, processedFps: 10 },
      model: { name: "yolo11n.pt", device: "cpu", imageSize: 640 },
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
});
