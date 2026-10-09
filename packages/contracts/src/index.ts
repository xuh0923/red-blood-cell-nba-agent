import { z } from "zod";

export const metricKindSchema = z.enum([
  "expected_field_goal_percentage",
  "on_ball_gravity",
  "off_ball_gravity",
  "win_impact"
]);

export type MetricKind = z.infer<typeof metricKindSchema>;

export const metricSchema = z.object({
  kind: metricKindSchema,
  value: z.number(),
  unit: z.enum(["percent", "index", "points"]),
  label: z.string().min(1),
  source: z.string().min(1),
  confidence: z.number().min(0).max(1).optional()
});

export const overlayEventSchema = z.object({
  id: z.string().min(1),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  title: z.string().min(1),
  explanation: z.string().min(1),
  player: z.string().min(1).optional(),
  metric: metricSchema,
  anchor: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
  accent: z.enum(["cyan", "amber", "red", "green"]),
  evidence: z.array(z.string().min(1)).min(1)
}).refine((event) => event.endSeconds > event.startSeconds, {
  message: "endSeconds must be greater than startSeconds"
});

export const narrationCueSchema = z.object({
  id: z.string().min(1),
  startSeconds: z.number().min(0),
  text: z.string().min(1),
  emotion: z.enum(["neutral", "focused", "excited", "surprised", "happy"])
});

export const analysisSchema = z.object({
  version: z.literal("1.0"),
  summary: z.string().min(1),
  generatedBy: z.enum(["local-rules", "bedrock", "agentcore"]),
  events: z.array(overlayEventSchema),
  narration: z.array(narrationCueSchema),
  warnings: z.array(z.string()),
  provenance: z.object({
    videoFile: z.string().min(1),
    dataFile: z.string().min(1),
    inputDigest: z.string().min(1).optional()
  })
});

export const jobStatusSchema = z.enum([
  "draft", "uploading", "queued", "extracting_frames", "analyzing",
  "rendering", "publishing", "completed", "failed"
]);

export const normalizedBoxSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1)
});

export const rosterPlayerSchema = z.object({
  playerId: z.string().min(1),
  name: z.string().min(1),
  jerseyNumber: z.string().regex(/^\d{1,2}$/),
  aliases: z.array(z.string().min(1)).default([]),
  activeIntervals: z.array(z.object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive()
  }).refine((interval) => interval.endSeconds > interval.startSeconds)).default([])
});

export const identitySourceSchema = z.enum(["unconfirmed", "ocr", "manual"]);

export const gameRosterSchema = z.object({
  version: z.literal("1.0"),
  gameId: z.string().min(1),
  teams: z.array(z.object({
    teamCode: z.string().min(2).max(8),
    teamName: z.string().min(1),
    players: z.array(rosterPlayerSchema).min(1)
  })).length(2)
}).superRefine((roster, context) => {
  const teamCodes = new Set(roster.teams.map((team) => team.teamCode));
  const playerIds = new Set<string>();
  if (teamCodes.size !== roster.teams.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "teamCode must be unique" });
  }
  for (const team of roster.teams) {
    const numbers = new Set(team.players.map((player) => player.jerseyNumber));
    if (numbers.size !== team.players.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `jerseyNumber must be unique for ${team.teamCode}` });
    }
    for (const player of team.players) {
      if (playerIds.has(player.playerId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "playerId must be unique for a game" });
      }
      playerIds.add(player.playerId);
    }
  }
});

export const trackedPlayerSchema = z.object({
  trackId: z.number().int().nonnegative(),
  label: z.string().min(1),
  role: z.enum(["player", "referee-candidate"]),
  team: z.enum(["team-a", "team-b", "unknown"]),
  confidence: z.number().min(0).max(1),
  identityConfidence: z.number().min(0).max(1),
  identitySource: identitySourceSchema.default("unconfirmed"),
  jerseyNumber: z.string().optional(),
  playerId: z.string().optional(),
  playerName: z.string().optional(),
  box: normalizedBoxSchema
});

export const trackingResultSchema = z.object({
  version: z.literal("1.0"),
  video: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().positive(),
    sourceFps: z.number().positive(),
    processedFps: z.number().positive()
  }),
  model: z.object({
    name: z.string().min(1),
    device: z.string().min(1),
    imageSize: z.number().int().positive()
  }),
  frames: z.array(z.object({
    atSeconds: z.number().min(0),
    players: z.array(trackedPlayerSchema),
    ball: z.object({
      confidence: z.number().min(0).max(1),
      box: normalizedBoxSchema
    }).optional()
  })),
  tracks: z.array(z.object({
    trackId: z.number().int().nonnegative(),
    label: z.string().min(1),
    role: z.enum(["player", "referee-candidate"]),
    team: z.enum(["team-a", "team-b", "unknown"]),
    firstSeen: z.number().min(0),
    lastSeen: z.number().min(0),
    observations: z.number().int().positive(),
    identityConfidence: z.number().min(0).max(1),
    identitySource: identitySourceSchema.default("unconfirmed"),
    jerseyNumber: z.string().optional(),
    playerId: z.string().optional(),
    playerName: z.string().optional()
  })),
  roster: z.object({
    gameId: z.string().min(1),
    sourceFile: z.string().min(1),
    teamCodes: z.array(z.string().min(2)).length(2),
    playerCount: z.number().int().positive(),
    players: z.array(z.object({
      teamCode: z.string().min(2),
      playerId: z.string().min(1),
      name: z.string().min(1),
      jerseyNumber: z.string().regex(/^\d{1,2}$/)
    })).min(2)
  }).optional(),
  warnings: z.array(z.string())
});

export const jobSchema = z.object({
  id: z.string().uuid(),
  status: jobStatusSchema,
  progress: z.number().int().min(0).max(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  videoKey: z.string().min(1),
  dataKey: z.string().min(1),
  videoDurationSeconds: z.number().positive(),
  frames: z.array(z.object({
    key: z.string().min(1),
    atSeconds: z.number().min(0)
  })).min(3).max(8),
  resultUrl: z.string().url().optional(),
  analysis: analysisSchema.optional(),
  error: z.string().optional()
});

export const createJobRequestSchema = z.object({
  videoFileName: z.string().min(1),
  videoContentType: z.enum(["video/mp4", "video/quicktime"]),
  dataFileName: z.string().min(1),
  dataContentType: z.enum(["application/json", "text/csv"]),
  videoDurationSeconds: z.number().positive(),
  frameTimestamps: z.array(z.number().min(0)).min(3).max(8)
}).refine((request) => request.frameTimestamps.every((time) => time <= request.videoDurationSeconds), {
  message: "frame timestamp exceeds video duration",
  path: ["frameTimestamps"]
});

export const createJobResponseSchema = z.object({
  job: jobSchema,
  uploads: z.object({
    video: z.object({ url: z.string().url(), key: z.string() }),
    data: z.object({ url: z.string().url(), key: z.string() }),
    frames: z.array(z.object({
      url: z.string().url(),
      key: z.string(),
      atSeconds: z.number().min(0)
    }))
  })
});

const deviceEnvelope = {
  version: z.literal(1),
  jobId: z.string().uuid(),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  issuedAt: z.string().datetime()
};

export const deviceEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...deviceEnvelope,
    type: z.literal("narration"),
    text: z.string().min(1),
    emotion: narrationCueSchema.shape.emotion,
    audioUrl: z.string().url().optional()
  }),
  z.object({
    ...deviceEnvelope,
    type: z.literal("status"),
    state: z.enum(["connected", "buffering", "speaking", "idle", "error"]),
    message: z.string().optional()
  })
]);

export type Metric = z.infer<typeof metricSchema>;
export type OverlayEvent = z.infer<typeof overlayEventSchema>;
export type NarrationCue = z.infer<typeof narrationCueSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type NormalizedBox = z.infer<typeof normalizedBoxSchema>;
export type GameRoster = z.infer<typeof gameRosterSchema>;
export type IdentitySource = z.infer<typeof identitySourceSchema>;
export type TrackedPlayer = z.infer<typeof trackedPlayerSchema>;
export type TrackingResult = z.infer<typeof trackingResultSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;
export type DeviceEvent = z.infer<typeof deviceEventSchema>;

export const metricDisplay = (metric: Metric): string => {
  if (metric.unit === "percent") return `${Math.round(metric.value * 100)}%`;
  if (metric.unit === "points") return `${metric.value > 0 ? "+" : ""}${metric.value.toFixed(1)}`;
  return metric.value.toFixed(2);
};
