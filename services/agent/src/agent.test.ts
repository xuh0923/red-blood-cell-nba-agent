import { describe, expect, it } from "vitest";
import { LocalRulesAnalyzer } from "./index.js";

describe("LocalRulesAnalyzer", () => {
  it("uses recognized source metrics and records provenance", async () => {
    const result = await new LocalRulesAnalyzer().analyze({
      videoFileName: "clip.mp4",
      dataFileName: "events.json",
      structuredData: { expectedFieldGoalPercentage: 36, onBallGravity: 1.62, winImpact: -0.4 }
    });
    expect(result.provenance.videoFile).toBe("clip.mp4");
    expect(result.events[1]!.metric.value).toBe(0.36);
    expect(result.events[0]!.metric.value).toBe(1.62);
    expect(result.events[2]!.metric.value).toBe(-0.4);
  });

  it("never reports itself as AgentCore", async () => {
    const result = await new LocalRulesAnalyzer().analyze({
      videoFileName: "clip.mp4", dataFileName: "demo.json", structuredData: {}
    });
    expect(result.generatedBy).toBe("local-rules");
    expect(result.warnings.join(" ")).toContain("AgentCore");
  });
});
