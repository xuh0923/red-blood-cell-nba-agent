import { describe, expect, it } from "vitest";
import { buildRekognitionTracking, type LabelDetectionLike } from "./rekognition-tracking.js";

const person = (timestamp: number, left: number): LabelDetectionLike => ({
  Timestamp: timestamp,
  Label: {
    Name: "Person",
    Instances: [{ Confidence: 92, BoundingBox: { Left: left, Top: 0.42, Width: 0.08, Height: 0.25 } }]
  }
});

describe("Rekognition tracking adapter", () => {
  it("associates nearby person detections but leaves identity unconfirmed", () => {
    const tracking = buildRekognitionTracking([person(0, 0.2), person(500, 0.22), person(1000, 0.24)], {
      durationSeconds: 2,
      width: 1920,
      height: 1080,
      sourceFps: 60
    });
    expect(tracking.frames).toHaveLength(3);
    expect(tracking.tracks).toHaveLength(1);
    expect(tracking.tracks[0]?.identitySource).toBe("unconfirmed");
    expect(tracking.tracks[0]?.playerName).toBeUndefined();
    expect(tracking.model.device).toBe("aws-managed");
  });
});
