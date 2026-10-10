import { describe, expect, it } from "vitest";
import { NBA_COURT, threePointArcPath, toCourtPoint } from "./court-geometry";

describe("NBA court geometry", () => {
  it("normalizes tracking coordinates into 94 by 50 feet", () => {
    expect(toCourtPoint({ x: 0.5, y: 0.5 })).toEqual({ x: 47, y: 25 });
    expect(toCourtPoint({ x: 47, y: 25 })).toEqual({ x: 47, y: 25 });
    expect(toCourtPoint({ x: 95, y: 25 })).toBeUndefined();
  });

  it("uses mirrored three-point arc centers", () => {
    const left = threePointArcPath(NBA_COURT.leftRimX, "left");
    const right = threePointArcPath(NBA_COURT.rightRimX, "right");
    expect(Number(left.match(/M ([0-9.]+) 3/)?.[1])).toBeCloseTo(14.198, 2);
    expect(Number(right.match(/M ([0-9.]+) 3/)?.[1])).toBeCloseTo(79.802, 2);
  });
});
