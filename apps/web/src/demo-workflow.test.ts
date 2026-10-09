import { describe, expect, it } from "vitest";
import { createDemoAnalysis } from "./demo-workflow";

describe("browser demo workflow", () => {
  it("adapts recognized values without inventing additional events", () => {
    const result = createDemoAnalysis("clip.mp4", "metrics.json", { xfg_pct: 51, gravity_score: 1.8 });
    expect(result.events).toHaveLength(3);
    expect(result.events[1]!.metric.value).toBe(0.51);
    expect(result.events[0]!.metric.value).toBe(1.8);
  });
});
