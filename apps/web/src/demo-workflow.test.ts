import { describe, expect, it } from "vitest";
import { createDemoAnalysis, parseDataFile, parseStatsTimeline } from "./demo-workflow";

describe("browser demo workflow", () => {
  it("adapts recognized values without inventing missing metric events", () => {
    const result = createDemoAnalysis("clip.mp4", "metrics.json", { xfg_pct: 51, gravity_score: 1.8 });
    expect(result.events).toHaveLength(2);
    expect(result.events[1]!.metric.value).toBe(0.51);
    expect(result.events[0]!.metric.value).toBe(1.8);
  });

  it("parses quoted CSV fields and numeric values", async () => {
    const result = await parseDataFile(new File([
      "time,xfg_pct,note\r\n1.5,51,\"corner, three\"\r\n"
    ], "shots.csv", { type: "text/csv" }));
    expect(result).toEqual([{ time: 1.5, xfg_pct: 51, note: "corner, three" }]);
  });

  it("does not use demo metrics when input has no recognized values", () => {
    const result = createDemoAnalysis("clip.mp4", "empty.json", {});
    expect(result.events).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("不会用演示指标");
  });

  it("accepts a canonical stats timeline and rejects unrelated input", () => {
    const timeline = parseStatsTimeline({
      version: "1.0",
      gameId: "game-1",
      source: "official",
      snapshots: [{ atSeconds: 0, teams: [{ teamCode: "AA", score: 0 }, { teamCode: "BB", score: 0 }] }]
    });
    expect(timeline?.gameId).toBe("game-1");
    expect(parseStatsTimeline({ foo: "bar" })).toBeUndefined();
  });
});
