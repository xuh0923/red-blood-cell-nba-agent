export const NBA_COURT = {
  length: 94,
  width: 50,
  centerX: 47,
  centerY: 25,
  centerCircleRadius: 6,
  rimRadius: 0.75,
  restrictedRadius: 4,
  threePointRadius: 23.75,
  leftRimX: 5.25,
  rightRimX: 88.75,
  leftBackboardX: 4,
  rightBackboardX: 90,
  leftFreeThrowX: 19,
  rightFreeThrowX: 75,
  laneTop: 17,
  laneBottom: 33,
} as const;

export type CourtPoint = { x: number; y: number };

export function isFiniteCourtPoint(point: unknown): point is CourtPoint {
  if (!point || typeof point !== "object") return false;
  const candidate = point as CourtPoint;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

/** Tracking contracts use normalized coordinates; fixtures may already use feet. */
export function toCourtPoint(point: unknown): CourtPoint | undefined {
  if (!isFiniteCourtPoint(point)) return undefined;
  const normalized = point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1;
  const result = normalized
    ? { x: point.x * NBA_COURT.length, y: point.y * NBA_COURT.width }
    : { x: point.x, y: point.y };
  return result.x >= 0 && result.x <= NBA_COURT.length && result.y >= 0 && result.y <= NBA_COURT.width ? result : undefined;
}

export function mirrorX(point: CourtPoint): CourtPoint {
  return { x: NBA_COURT.length - point.x, y: point.y };
}

export function threePointArcPath(rimX: number, side: "left" | "right"): string {
  const intersection = Math.sqrt(NBA_COURT.threePointRadius ** 2 - 22 ** 2);
  const x = side === "left" ? rimX + intersection : rimX - intersection;
  const outerX = side === "left" ? rimX + NBA_COURT.threePointRadius : rimX - NBA_COURT.threePointRadius;
  const sweep = side === "left" ? 1 : 0;
  return `M ${x} 3 A ${NBA_COURT.threePointRadius} ${NBA_COURT.threePointRadius} 0 0 ${sweep} ${outerX} 25 A ${NBA_COURT.threePointRadius} ${NBA_COURT.threePointRadius} 0 0 ${sweep} ${x} 47`;
}

export function restrictedAreaPath(rimX: number, side: "left" | "right"): string {
  const sweep = side === "left" ? 1 : 0;
  return `M ${rimX} ${NBA_COURT.centerY - NBA_COURT.restrictedRadius} A ${NBA_COURT.restrictedRadius} ${NBA_COURT.restrictedRadius} 0 0 ${sweep} ${rimX} ${NBA_COURT.centerY + NBA_COURT.restrictedRadius}`;
}
