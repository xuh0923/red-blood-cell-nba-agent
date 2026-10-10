import { trackingResultSchema, type NormalizedBox, type TrackingResult } from "@courtvision/contracts";

interface RekognitionBox { Left?: number; Top?: number; Width?: number; Height?: number }
export interface LabelDetectionLike {
  Timestamp?: number;
  Label?: { Name?: string; Instances?: Array<{ Confidence?: number; BoundingBox?: RekognitionBox }> };
}
interface Candidate { confidence: number; box: NormalizedBox }

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const normalize = (box?: RekognitionBox): NormalizedBox | undefined => {
  if (!box) return undefined;
  const x = clamp(box.Left ?? 0);
  const y = clamp(box.Top ?? 0);
  return { x, y, width: Math.min(clamp(box.Width ?? 0), 1 - x), height: Math.min(clamp(box.Height ?? 0), 1 - y) };
};
const iou = (left: NormalizedBox, right: NormalizedBox): number => {
  const x1 = Math.max(left.x, right.x), y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width), y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
};
const onCourt = (box: NormalizedBox): boolean => {
  const bottom = box.y + box.height;
  const aspect = box.height / Math.max(box.width, 0.001);
  return box.height >= 0.105 && box.height <= 0.62 && box.width <= 0.32 && bottom >= 0.34 && bottom <= 0.91 && aspect >= 1.12;
};
const association = (previous: NormalizedBox, current: NormalizedBox): number | undefined => {
  const overlap = iou(previous, current);
  const px = previous.x + previous.width / 2, py = previous.y + previous.height / 2;
  const cx = current.x + current.width / 2, cy = current.y + current.height / 2;
  const distance = Math.hypot(px - cx, py - cy);
  if (overlap < 0.04 && distance > 0.16) return undefined;
  return overlap * 2 + Math.max(0, 0.22 - distance);
};

export const buildRekognitionTracking = (
  labels: LabelDetectionLike[],
  input: { durationSeconds: number; width?: number; height?: number; sourceFps?: number }
): TrackingResult => {
  const peopleByTime = new Map<number, Candidate[]>();
  const ballByTime = new Map<number, Candidate>();
  for (const detection of labels) {
    if (detection.Timestamp === undefined) continue;
    const name = detection.Label?.Name?.toLowerCase() ?? "";
    for (const instance of detection.Label?.Instances ?? []) {
      const box = normalize(instance.BoundingBox);
      if (!box) continue;
      const candidate = { box, confidence: clamp((instance.Confidence ?? 0) / 100) };
      if (/(person|people|human)/.test(name) && onCourt(box)) {
        const list = peopleByTime.get(detection.Timestamp) ?? [];
        if (!list.some((item) => iou(item.box, box) > 0.85)) list.push(candidate);
        peopleByTime.set(detection.Timestamp, list);
      } else if (/(^|\s)(basket)?ball($|\s)/.test(name)) {
        const current = ballByTime.get(detection.Timestamp);
        if (!current || candidate.confidence > current.confidence) ballByTime.set(detection.Timestamp, candidate);
      }
    }
  }

  let nextTrackId = 1;
  const active = new Map<number, { timestamp: number; box: NormalizedBox }>();
  const frameMap = new Map<number, TrackingResult["frames"][number]>();
  for (const [timestamp, candidates] of [...peopleByTime].sort((a, b) => a[0] - b[0])) {
    const atSeconds = Math.min(input.durationSeconds, Math.round(timestamp / 100) / 10);
    const frame: TrackingResult["frames"][number] = { atSeconds, players: [] };
    const used = new Set<number>();
    for (const candidate of candidates.sort((a, b) => b.confidence - a.confidence).slice(0, 14)) {
      let bestId: number | undefined;
      let bestScore = 0;
      for (const [trackId, previous] of active) {
        if (used.has(trackId) || timestamp - previous.timestamp > 1500) continue;
        const score = association(previous.box, candidate.box);
        if (score !== undefined && score > bestScore) { bestId = trackId; bestScore = score; }
      }
      const trackId = bestId ?? nextTrackId++;
      used.add(trackId);
      active.set(trackId, { timestamp, box: candidate.box });
      frame.players.push({
        trackId, label: `轨迹 ${String(trackId).padStart(2, "0")}`, role: "player", team: "unknown",
        confidence: candidate.confidence, identityConfidence: 0, identitySource: "unconfirmed", box: candidate.box
      });
    }
    const ball = ballByTime.get(timestamp);
    if (ball) frame.ball = ball;
    frameMap.set(atSeconds, frame);
  }

  const frames = [...frameMap.values()].sort((a, b) => a.atSeconds - b.atSeconds);
  const counts = new Map<number, number>();
  for (const frame of frames) for (const player of frame.players) counts.set(player.trackId, (counts.get(player.trackId) ?? 0) + 1);
  for (const frame of frames) frame.players = frame.players.filter((player) => (counts.get(player.trackId) ?? 0) >= 2);
  const tracks = new Map<number, TrackingResult["tracks"][number]>();
  for (const frame of frames) for (const player of frame.players) {
    const current = tracks.get(player.trackId);
    if (current) { current.lastSeen = frame.atSeconds; current.observations += 1; }
    else tracks.set(player.trackId, {
      trackId: player.trackId, label: player.label, role: "player", team: "unknown",
      firstSeen: frame.atSeconds, lastSeen: frame.atSeconds, observations: 1,
      identityConfidence: 0, identitySource: "unconfirmed"
    });
  }
  const processedFps = frames.length > 1 ? Math.max(0.1, (frames.length - 1) / Math.max(0.1, frames.at(-1)!.atSeconds - frames[0]!.atSeconds)) : 0.1;
  return trackingResultSchema.parse({
    version: "1.0",
    video: { width: input.width ?? 1920, height: input.height ?? 1080, durationSeconds: input.durationSeconds, sourceFps: input.sourceFps ?? 30, processedFps },
    model: { name: "amazon-rekognition-video-label-detection+iou-tracking", device: "aws-managed", imageSize: Math.max(input.width ?? 1920, input.height ?? 1080) },
    quality: {
      frameCoverage: Math.min(1, frames.length / Math.max(1, input.durationSeconds * 2)),
      ballFrameCoverage: frames.length ? frames.filter((frame) => frame.ball).length / frames.length : 0,
      meanPlayerConfidence: frames.flatMap((frame) => frame.players).reduce((sum, player, _, all) => sum + player.confidence / Math.max(1, all.length), 0),
      trackCount: tracks.size
    },
    videoEvidence: [], frames, tracks: [...tracks.values()], warnings: [
      "AWS 托管基线提供人物框与连续轨迹，但通用模型不能可靠区分球员、裁判和场边人员。",
      "球员姓名必须由球衣号码、多帧投票和比赛名单确认；当前云端基线不会猜测姓名。",
      "标准球场进攻路线需要球场标定；未完成标定时不生成伪造的雷达坐标。"
    ]
  });
};
