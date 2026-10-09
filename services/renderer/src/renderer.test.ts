import { describe, expect, it } from "vitest";
import { demoAnalysis } from "@courtvision/contracts/fixtures";
import { buildFfmpegArgs, buildFilterScript } from "./index.js";

describe("renderer", () => {
  it("creates timed overlays for each event", () => {
    const script = buildFilterScript(demoAnalysis);
    expect(script.match(/between\(t,/g)).toHaveLength(demoAnalysis.events.length * 2);
    expect(script).toContain("预期命中率");
    expect(script).toMatch(/^\[0:v\].*\[vout\]$/s);
  });

  it("passes file names as separate process arguments", () => {
    const args = buildFfmpegArgs("input video.mp4", "filters.txt", "final video.mp4");
    expect(args).toContain("input video.mp4");
    expect(args.at(-1)).toBe("final video.mp4");
  });
});
