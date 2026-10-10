import { describe, expect, it } from "vitest";
import { calculateVideoDigest } from "./video-digest";

describe("calculateVideoDigest", () => {
  it("returns a stable SHA-256 content identity", async () => {
    const first = await calculateVideoDigest(new Blob(["courtvision"]));
    const renamed = await calculateVideoDigest(new Blob(["courtvision"]));
    const different = await calculateVideoDigest(new Blob(["courtvision-2"]));

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(renamed).toBe(first);
    expect(different).not.toBe(first);
  });
});
