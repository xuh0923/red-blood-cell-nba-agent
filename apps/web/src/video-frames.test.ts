import { describe, expect, it } from "vitest";
import { sampleTimestamps } from "./video-frames";

describe("video frame sampling", () => {
  it("spreads frames across the full clip without touching either edge", () => {
    const timestamps = sampleTimestamps(24, 6);
    expect(timestamps).toHaveLength(6);
    expect(timestamps[0]).toBeGreaterThan(0);
    expect(timestamps.at(-1)).toBeLessThan(24);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it("rejects an invalid duration", () => {
    expect(() => sampleTimestamps(0)).toThrow();
  });
});
