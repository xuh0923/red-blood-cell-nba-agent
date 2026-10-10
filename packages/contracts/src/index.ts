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
  generatedBy: z.literal("local-rules"),
  events: z.array(overlayEventSchema),
  narration: z.array(narrationCueSchema),
  warnings: z.array(z.string()),
  provenance: z.object({
    videoFile: z.string().min(1),
    dataFile: z.string().min(1),
    inputDigest: z.string().min(1).optional()
  })
});

export const evidenceRefSchema = z.object({
  kind: z.enum(["data", "tracking", "frame", "official"]),
  source: z.string().min(1),
  locator: z.string().min(1),
  atSeconds: z.number().min(0).optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const analysisContextWindowSchema = z.object({
  id: z.string().min(1),
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  metrics: z.array(z.object({
    name: z.string().min(1),
    value: z.number(),
    unit: z.string().min(1),
    formula: z.string().min(1).optional(),
    evidence: z.array(evidenceRefSchema).min(1)
  })),
  evidence: z.array(evidenceRefSchema)
}).refine((window) => window.endSeconds > window.startSeconds, {
  message: "analysis context window endSeconds must be greater than startSeconds"
});

export const analysisContextSchema = z.object({
  version: z.literal("1.0"),
  video: z.object({ durationSeconds: z.number().positive() }),
  windows: z.array(analysisContextWindowSchema),
  trackingQuality: z.object({
    provider: z.string().min(1),
    frameCoverage: z.number().min(0).max(1),
    ballRecall: z.number().min(0).max(1).optional(),
    idSwitches: z.number().int().nonnegative().optional()
  }).optional(),
  warnings: z.array(z.string())
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

const countSchema = z.number().int().nonnegative();

export const matchEvidenceSchema = z.object({
  type: z.enum(["scoreboard", "team", "player", "jersey", "score-event", "audio", "watermark", "manual", "official"]),
  value: z.string().min(1),
  atSeconds: z.number().min(0).optional(),
  confidence: z.number().min(0).max(1),
  source: z.string().min(1)
});

export const matchCandidateSchema = z.object({
  gameId: z.string().min(1),
  teams: z.array(z.object({
    teamCode: z.string().min(2).max(8),
    teamName: z.string().min(1)
  })).length(2),
  gameDate: z.string().min(1).optional(),
  finalScore: z.array(countSchema).length(2).optional(),
  playerNames: z.array(z.string().min(1)).default([]),
  jerseyNumbers: z.array(z.string().regex(/^\d{1,2}$/)).default([]),
  source: z.string().min(1)
});

export const matchResolutionSchema = z.object({
  status: z.enum(["confirmed", "ambiguous", "unconfirmed"]),
  confidence: z.number().min(0).max(1),
  selectedGameId: z.string().min(1).optional(),
  candidates: z.array(z.object({
    gameId: z.string().min(1),
    score: z.number().min(0).max(1),
    reasons: z.array(z.string().min(1))
  })).default([]),
  evidence: z.array(matchEvidenceSchema).default([]),
  warnings: z.array(z.string()).default([])
});

const madeAttemptedSchema = z.object({
  made: countSchema,
  attempted: countSchema
}).refine((stat) => stat.made <= stat.attempted, { message: "made cannot exceed attempted" });

export const teamStatsSchema = z.object({
  teamCode: z.string().min(2).max(8),
  teamName: z.string().min(1).optional(),
  score: countSchema,
  fieldGoals: madeAttemptedSchema.optional(),
  threePoints: madeAttemptedSchema.optional(),
  freeThrows: madeAttemptedSchema.optional(),
  assists: countSchema.optional(),
  turnovers: countSchema.optional(),
  rebounds: z.object({ offensive: countSchema, defensive: countSchema }).optional(),
  steals: countSchema.optional(),
  blocks: countSchema.optional(),
  chargesDrawn: countSchema.optional(),
  possessions: z.number().nonnegative().optional(),
  offensiveRating: z.number().nonnegative().optional(),
  defensiveRating: z.number().nonnegative().optional(),
  possessionTimeShare: z.number().min(0).max(1).optional(),
  fouls: z.object({ period: countSchema, game: countSchema }).optional(),
  timeouts: z.object({ used: countSchema, remaining: countSchema }).optional(),
  coachChallenges: z.object({ used: countSchema, remaining: countSchema }).optional(),
  paintPoints: countSchema.optional(),
  fastBreakPoints: countSchema.optional(),
  secondChancePoints: countSchema.optional(),
  benchPoints: countSchema.optional(),
  largestLead: countSchema.optional(),
  leadingSeconds: z.number().nonnegative().optional(),
  trailingSeconds: z.number().nonnegative().optional()
});

export const gameStatsSnapshotSchema = z.object({
  atSeconds: z.number().min(0),
  period: z.number().int().positive().optional(),
  clock: z.string().min(1).optional(),
  teams: z.array(teamStatsSchema).length(2)
}).superRefine((snapshot, context) => {
  if (snapshot.teams[0]?.teamCode === snapshot.teams[1]?.teamCode) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshot teams must be unique" });
  }
});

export const gameStatsTimelineSchema = z.object({
  version: z.literal("1.0"),
  gameId: z.string().min(1),
  source: z.string().min(1),
  isDemo: z.boolean().default(false),
  snapshots: z.array(gameStatsSnapshotSchema).min(1),
  matchResolution: matchResolutionSchema.optional()
}).superRefine((timeline, context) => {
  for (let index = 1; index < timeline.snapshots.length; index += 1) {
    if (timeline.snapshots[index]!.atSeconds < timeline.snapshots[index - 1]!.atSeconds) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "snapshots must be sorted by atSeconds" });
      break;
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
  box: normalizedBoxSchema,
  /** Optional normalized court coordinates (0..1), produced by court calibration. */
  courtPosition: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  courtCoordinates: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional()
});

const tacticalPointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const tacticalTrajectorySchema = z.object({
  kind: z.enum(["movement", "pass", "shot"]).default("movement"),
  points: z.array(tacticalPointSchema).min(2)
});
const tacticalSpaceZoneSchema = z.object({
  center: tacticalPointSchema,
  radiusX: z.number().positive().max(1),
  radiusY: z.number().positive().max(1)
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
  quality: z.object({
    frameCoverage: z.number().min(0).max(1),
    ballFrameCoverage: z.number().min(0).max(1),
    meanPlayerConfidence: z.number().min(0).max(1),
    trackCount: z.number().int().nonnegative(),
    idSwitches: z.number().int().nonnegative().optional()
  }).optional(),
  videoEvidence: z.array(matchEvidenceSchema).default([]),
  frames: z.array(z.object({
    atSeconds: z.number().min(0),
    players: z.array(trackedPlayerSchema),
    ball: z.object({
      confidence: z.number().min(0).max(1),
      box: normalizedBoxSchema,
      courtPosition: tacticalPointSchema.optional(),
      courtCoordinates: tacticalPointSchema.optional()
    }).optional(),
    trajectories: z.array(tacticalTrajectorySchema).optional(),
    spaceZones: z.array(tacticalSpaceZoneSchema).optional()
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
  videoFileName: z.string().min(1).optional(),
  videoSizeBytes: z.number().int().positive().optional(),
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  dataKey: z.string().min(1),
  videoDurationSeconds: z.number().positive(),
  videoWidth: z.number().int().positive().optional(),
  videoHeight: z.number().int().positive().optional(),
  sourceFps: z.number().positive().optional(),
  frames: z.array(z.object({
    key: z.string().min(1),
    atSeconds: z.number().min(0)
  })).min(3).max(8),
  resultUrl: z.string().url().optional(),
  analysis: analysisSchema.optional(),
  tracking: trackingResultSchema.optional(),
  trackingKey: z.string().min(1).optional(),
  visionProvider: z.enum(["rekognition-video", "sagemaker", "local"]).optional(),
  mediaJobId: z.string().min(1).optional(),
  mediaStatus: z.enum(["queued", "processing", "complete", "error"]).optional(),
  playbackKey: z.string().min(1).optional(),
  stats: gameStatsTimelineSchema.optional(),
  error: z.string().optional()
});

export const createJobRequestSchema = z.object({
  videoFileName: z.string().min(1),
  videoContentType: z.enum(["video/mp4", "video/quicktime"]),
  videoSizeBytes: z.number().int().positive().max(5 * 1024 * 1024 * 1024).optional(),
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  dataFileName: z.string().min(1),
  dataContentType: z.enum(["application/json", "text/csv"]),
  videoDurationSeconds: z.number().positive(),
  videoWidth: z.number().int().positive().optional(),
  videoHeight: z.number().int().positive().optional(),
  sourceFps: z.number().positive().optional(),
  frameTimestamps: z.array(z.number().min(0)).min(3).max(8)
}).refine((request) => request.frameTimestamps.every((time) => time <= request.videoDurationSeconds), {
  message: "frame timestamp exceeds video duration",
  path: ["frameTimestamps"]
});

export const createJobResponseSchema = z.object({
  job: jobSchema,
  uploads: z.object({
    video: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("single"), url: z.string().url(), key: z.string() }),
      z.object({
        mode: z.literal("multipart"),
        key: z.string(),
        uploadId: z.string().min(1),
        partSizeBytes: z.number().int().min(5 * 1024 * 1024),
        parts: z.array(z.object({
          partNumber: z.number().int().min(1).max(10_000),
          url: z.string().url()
        })).min(2).max(100)
      })
    ]),
    data: z.object({ url: z.string().url(), key: z.string() }),
    frames: z.array(z.object({
      url: z.string().url(),
      key: z.string(),
      atSeconds: z.number().min(0)
    }))
  })
});

export const completedMultipartPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  etag: z.string().min(1)
});

export const completeMultipartUploadRequestSchema = z.object({
  uploadId: z.string().min(1),
  parts: z.array(completedMultipartPartSchema).min(2).max(100)
}).refine((request) => new Set(request.parts.map((part) => part.partNumber)).size === request.parts.length, {
  message: "multipart part numbers must be unique",
  path: ["parts"]
});

export const abortMultipartUploadRequestSchema = z.object({
  uploadId: z.string().min(1)
});

export const videoDuplicateCheckRequestSchema = z.object({
  inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  videoFileName: z.string().min(1),
  videoSizeBytes: z.number().int().positive()
});

export const existingVideoSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  status: jobStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const videoDuplicateCheckResponseSchema = z.object({
  duplicate: z.boolean(),
  existing: existingVideoSchema.optional()
});

export const completedWorkSchema = z.object({
  id: z.string().uuid(),
  teamId: z.literal("Team28"),
  title: z.string().min(1),
  videoUrl: z.string().url(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  durationSeconds: z.number().positive(),
  analysis: analysisSchema,
  tracking: trackingResultSchema.optional(),
  stats: gameStatsTimelineSchema.optional()
});

export const completedWorksResponseSchema = z.object({
  works: z.array(completedWorkSchema)
});

export const storageObjectCategorySchema = z.enum(["video", "data", "frame", "analysis", "other"]);

export const storageObjectSchema = z.object({
  key: z.string().min(1),
  category: storageObjectCategorySchema,
  sizeBytes: z.number().int().nonnegative(),
  lastModified: z.string().datetime(),
  storageClass: z.string().min(1).optional()
});

export const storageCatalogResponseSchema = z.object({
  bucketName: z.string().min(1),
  refreshedAt: z.string().datetime(),
  objects: z.array(storageObjectSchema)
});

export type Metric = z.infer<typeof metricSchema>;
export type OverlayEvent = z.infer<typeof overlayEventSchema>;
export type NarrationCue = z.infer<typeof narrationCueSchema>;
export type Analysis = z.infer<typeof analysisSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type AnalysisContextWindow = z.infer<typeof analysisContextWindowSchema>;
export type AnalysisContext = z.infer<typeof analysisContextSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type NormalizedBox = z.infer<typeof normalizedBoxSchema>;
export type GameRoster = z.infer<typeof gameRosterSchema>;
export type MatchEvidence = z.infer<typeof matchEvidenceSchema>;
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;
export type MatchResolution = z.infer<typeof matchResolutionSchema>;
export type TeamStats = z.infer<typeof teamStatsSchema>;
export type GameStatsSnapshot = z.infer<typeof gameStatsSnapshotSchema>;
export type GameStatsTimeline = z.infer<typeof gameStatsTimelineSchema>;
export type IdentitySource = z.infer<typeof identitySourceSchema>;
export type TrackedPlayer = z.infer<typeof trackedPlayerSchema>;
export type TrackingResult = z.infer<typeof trackingResultSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type CreateJobResponse = z.infer<typeof createJobResponseSchema>;
export type CompletedMultipartPart = z.infer<typeof completedMultipartPartSchema>;
export type VideoDuplicateCheckRequest = z.infer<typeof videoDuplicateCheckRequestSchema>;
export type VideoDuplicateCheckResponse = z.infer<typeof videoDuplicateCheckResponseSchema>;
export type ExistingVideo = z.infer<typeof existingVideoSchema>;
export type CompletedWork = z.infer<typeof completedWorkSchema>;
export type StorageObjectCategory = z.infer<typeof storageObjectCategorySchema>;
export type StorageObject = z.infer<typeof storageObjectSchema>;
export type StorageCatalogResponse = z.infer<typeof storageCatalogResponseSchema>;

export const metricDisplay = (metric: Metric): string => {
  if (metric.unit === "percent") return `${Math.round(metric.value * 100)}%`;
  if (metric.unit === "points") return `${metric.value > 0 ? "+" : ""}${metric.value.toFixed(1)}`;
  return metric.value.toFixed(2);
};
