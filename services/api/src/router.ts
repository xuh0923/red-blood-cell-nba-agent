import {
  abortMultipartUploadRequestSchema,
  completeMultipartUploadRequestSchema,
  createJobRequestSchema,
  videoDuplicateCheckRequestSchema,
  type CompletedMultipartPart,
  type Job,
  type TrackingResult
} from "@courtvision/contracts";

const MEBIBYTE = 1024 * 1024;
const MULTIPART_THRESHOLD_BYTES = 16 * MEBIBYTE;
const DEFAULT_PART_SIZE_BYTES = 8 * MEBIBYTE;
const MAX_MULTIPART_PARTS = 100;

export interface Request { method: string; path: string; body?: string }
export interface Response { statusCode: number; body: string; headers: Record<string, string> }
export interface JobStore {
  put(job: Job): Promise<void>;
  get(id: string): Promise<Job | undefined>;
  listCompleted(): Promise<Job[]>;
  findByDigest(digest: string): Promise<Job | undefined>;
}
export interface UploadSigner {
  sign(key: string, contentType: string): Promise<string>;
  createMultipart(key: string, contentType: string): Promise<string>;
  signPart(key: string, uploadId: string, partNumber: number): Promise<string>;
  completeMultipart(key: string, uploadId: string, parts: CompletedMultipartPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  signDownload(key: string): Promise<string>;
}
export interface WorkflowStarter { start(job: Job): Promise<void> }

interface Dependencies {
  store: JobStore;
  signer: UploadSigner;
  assets: {
    bucketName: string;
    list(): Promise<Array<{ key: string; sizeBytes: number; lastModified: string; storageClass?: string }>>;
    readTracking(key: string): Promise<TrackingResult | undefined>;
  };
  workflow: WorkflowStarter;
  now?: () => Date;
  uuid?: () => string;
}

const json = (statusCode: number, value: unknown): Response => ({
  statusCode,
  body: JSON.stringify(value),
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  }
});

const safeName = (name: string): string => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
const titleFromJob = (job: Job): string => (job.videoFileName ?? job.videoKey.split("/").at(-1) ?? "比赛片段").replace(/\.[^.]+$/, "");
const category = (key: string): "video" | "data" | "frame" | "analysis" | "other" => {
  const lower = key.toLowerCase();
  if (/\.(mp4|mov|mkv|webm)$/.test(lower)) return "video";
  if (/\.(jpg|jpeg|png|webp)$/.test(lower)) return "frame";
  if (lower.includes("/data/") || lower.startsWith("datasets/") || /\.(json|csv)$/.test(lower)) return "data";
  if (lower.startsWith("jobs/")) return "analysis";
  return "other";
};
const partSizeFor = (size: number): number => Math.max(DEFAULT_PART_SIZE_BYTES, Math.ceil(size / MAX_MULTIPART_PARTS / MEBIBYTE) * MEBIBYTE);

export const createRouter = ({ store, signer, assets, workflow, now = () => new Date(), uuid = () => crypto.randomUUID() }: Dependencies) => {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return json(204, {});

    if (request.method === "GET" && request.path === "/health") {
      return json(200, { status: "ok", team: "Team28", services: ["s3", "dynamodb", "rekognition-video", "mediaconvert", "cloudfront"] });
    }

    if (request.method === "GET" && request.path === "/storage") {
      const objects = (await assets.list()).map((object) => ({ ...object, category: category(object.key) }))
        .sort((left, right) => right.lastModified.localeCompare(left.lastModified));
      return json(200, { bucketName: assets.bucketName, refreshedAt: now().toISOString(), objects });
    }

    if (request.method === "GET" && request.path === "/works") {
      const completed = (await store.listCompleted()).filter((job) => job.analysis)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const unique = new Map<string, Job>();
      for (const job of completed) unique.set(job.inputDigest ?? job.id, job);
      const works = await Promise.all([...unique.values()].map(async (job) => ({
        id: job.id,
        teamId: "Team28" as const,
        title: titleFromJob(job),
        videoUrl: job.resultUrl ?? await signer.signDownload(job.videoKey),
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        durationSeconds: job.videoDurationSeconds,
        analysis: job.analysis!,
        tracking: job.tracking ?? (job.trackingKey ? await assets.readTracking(job.trackingKey) : undefined),
        stats: job.stats
      })));
      return json(200, { works });
    }

    if (request.method === "POST" && request.path === "/videos/check") {
      const parsed = videoDuplicateCheckRequestSchema.safeParse(JSON.parse(request.body ?? "{}"));
      if (!parsed.success) return json(400, { error: "视频校验参数无效" });
      const existing = await store.findByDigest(parsed.data.inputDigest);
      return json(200, existing && existing.status !== "failed" ? {
        duplicate: true,
        existing: { id: existing.id, title: titleFromJob(existing), status: existing.status, createdAt: existing.createdAt, updatedAt: existing.updatedAt }
      } : { duplicate: false });
    }

    if (request.method === "POST" && request.path === "/jobs") {
      let raw: unknown;
      try { raw = JSON.parse(request.body ?? "{}"); } catch { return json(400, { error: "请求正文不是有效 JSON" }); }
      const parsed = createJobRequestSchema.safeParse(raw);
      if (!parsed.success) return json(400, { error: "上传参数无效", details: parsed.error.flatten() });
      const duplicate = await store.findByDigest(parsed.data.inputDigest);
      if (duplicate && duplicate.status !== "failed") return json(409, {
        error: duplicate.status === "completed" ? "该视频已经分析完成" : "该视频任务正在处理中",
        code: "DUPLICATE_VIDEO",
        existing: { id: duplicate.id, title: titleFromJob(duplicate), status: duplicate.status, createdAt: duplicate.createdAt, updatedAt: duplicate.updatedAt }
      });

      const id = uuid();
      const timestamp = now().toISOString();
      const extension = parsed.data.videoContentType === "video/quicktime" ? "mov" : "mp4";
      const digest = parsed.data.inputDigest.slice("sha256:".length);
      const videoKey = `input/videos/${digest}.${extension}`;
      const dataKey = `input/${id}/data/${safeName(parsed.data.dataFileName)}`;
      const frames = parsed.data.frameTimestamps.map((atSeconds, index) => ({ key: `input/${id}/frames/frame-${String(index).padStart(2, "0")}.jpg`, atSeconds }));
      const job: Job = {
        id, status: "uploading", progress: 5, createdAt: timestamp, updatedAt: timestamp,
        videoKey, dataKey, frames, videoFileName: parsed.data.videoFileName,
        videoSizeBytes: parsed.data.videoSizeBytes, inputDigest: parsed.data.inputDigest,
        videoDurationSeconds: parsed.data.videoDurationSeconds, videoWidth: parsed.data.videoWidth,
        videoHeight: parsed.data.videoHeight, sourceFps: parsed.data.sourceFps
      };
      await store.put(job);
      const useMultipart = (parsed.data.videoSizeBytes ?? 0) >= MULTIPART_THRESHOLD_BYTES;
      const videoUpload = useMultipart ? await (async () => {
        const uploadId = await signer.createMultipart(videoKey, parsed.data.videoContentType);
        const partSizeBytes = partSizeFor(parsed.data.videoSizeBytes!);
        const partNumbers = Array.from({ length: Math.ceil(parsed.data.videoSizeBytes! / partSizeBytes) }, (_, index) => index + 1);
        const urls = await Promise.all(partNumbers.map((partNumber) => signer.signPart(videoKey, uploadId, partNumber)));
        return { mode: "multipart" as const, key: videoKey, uploadId, partSizeBytes, parts: partNumbers.map((partNumber, index) => ({ partNumber, url: urls[index]! })) };
      })() : { mode: "single" as const, key: videoKey, url: await signer.sign(videoKey, parsed.data.videoContentType) };
      const [dataUrl, frameUrls] = await Promise.all([
        signer.sign(dataKey, parsed.data.dataContentType),
        Promise.all(frames.map((frame) => signer.sign(frame.key, "image/jpeg")))
      ]);
      return json(201, { job, uploads: { video: videoUpload, data: { key: dataKey, url: dataUrl }, frames: frames.map((frame, index) => ({ ...frame, url: frameUrls[index] })) } });
    }

    const completeMatch = request.path.match(/^\/jobs\/([0-9a-f-]+)\/video\/complete$/i);
    if (request.method === "POST" && completeMatch?.[1]) {
      const job = await store.get(completeMatch[1]);
      if (!job) return json(404, { error: "任务不存在" });
      const parsed = completeMultipartUploadRequestSchema.safeParse(JSON.parse(request.body ?? "{}"));
      if (!parsed.success) return json(400, { error: "分片合并参数无效" });
      await signer.completeMultipart(job.videoKey, parsed.data.uploadId, parsed.data.parts);
      return json(200, { completed: true });
    }

    const abortMatch = request.path.match(/^\/jobs\/([0-9a-f-]+)\/video\/abort$/i);
    if (request.method === "POST" && abortMatch?.[1]) {
      const job = await store.get(abortMatch[1]);
      if (!job) return json(404, { error: "任务不存在" });
      const parsed = abortMultipartUploadRequestSchema.safeParse(JSON.parse(request.body ?? "{}"));
      if (!parsed.success) return json(400, { error: "分片中止参数无效" });
      await signer.abortMultipart(job.videoKey, parsed.data.uploadId);
      return json(200, { aborted: true });
    }

    const jobMatch = request.path.match(/^\/jobs\/([0-9a-f-]+)$/i);
    if (request.method === "GET" && jobMatch?.[1]) {
      const job = await store.get(jobMatch[1]);
      if (!job) return json(404, { error: "任务不存在" });
      const tracking = job.tracking ?? (job.trackingKey ? await assets.readTracking(job.trackingKey) : undefined);
      return json(200, tracking ? { ...job, tracking } : job);
    }

    const startMatch = request.path.match(/^\/jobs\/([0-9a-f-]+)\/start$/i);
    if (request.method === "POST" && startMatch?.[1]) {
      const job = await store.get(startMatch[1]);
      if (!job) return json(404, { error: "任务不存在" });
      if (job.status !== "uploading") return json(409, { error: "任务当前状态不能启动" });
      const updated: Job = { ...job, status: "queued", progress: 10, updatedAt: now().toISOString() };
      await store.put(updated);
      await workflow.start(updated);
      return json(202, updated);
    }
    return json(404, { error: "接口不存在" });
  };
};
