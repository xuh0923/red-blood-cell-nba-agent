import {
  createJobResponseSchema,
  jobSchema,
  type Analysis,
  type CreateJobRequest,
  type JobStatus,
  type TrackingResult
} from "@courtvision/contracts";
import type { ExtractedFrame } from "./video-frames";
import { calculateVideoDigest } from "./video-digest";

const configuredApi = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");
export const cloudAvailable = Boolean(configuredApi) || !["localhost", "127.0.0.1"].includes(window.location.hostname);
const apiBase = configuredApi ?? "/api";
const CONCURRENCY = 4;
const RETRIES = 3;

const requestJson = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `AWS 请求失败 (${response.status})`);
  return body;
};

const put = async (url: string, body: Blob, contentType?: string): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { method: "PUT", headers: contentType ? { "content-type": contentType } : undefined, body });
      if (!response.ok) throw new Error(`S3 上传失败 (${response.status})`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < RETRIES) await new Promise((resolve) => window.setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
};

const uploadMultipart = async (
  file: File,
  jobId: string,
  target: Extract<ReturnType<typeof createJobResponseSchema.parse>["uploads"]["video"], { mode: "multipart" }>,
  onBytes: (bytes: number) => void
) => {
  const queue = [...target.parts];
  const completed: Array<{ partNumber: number; etag: string }> = [];
  const worker = async () => {
    while (queue.length) {
      const part = queue.shift();
      if (!part) return;
      const start = (part.partNumber - 1) * target.partSizeBytes;
      const chunk = file.slice(start, Math.min(file.size, start + target.partSizeBytes));
      const response = await put(part.url, chunk);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`S3 未返回分片 ${part.partNumber} 的 ETag`);
      completed.push({ partNumber: part.partNumber, etag });
      onBytes(chunk.size);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, target.parts.length) }, worker));
    return completed.sort((left, right) => left.partNumber - right.partNumber);
  } catch (error) {
    await requestJson(`/jobs/${jobId}/video/abort`, { method: "POST", body: JSON.stringify({ uploadId: target.uploadId }) }).catch(() => undefined);
    throw error;
  }
};

interface CloudWorkflowInput {
  video: File;
  data?: File;
  duration: number;
  frames: ExtractedFrame[];
  inputDigest?: string;
  onProgress: (status: JobStatus, progress: number) => void;
}
export interface CloudRun { jobId: string; analysis: Analysis; tracking?: TrackingResult; videoUrl?: string }

export const runCloudWorkflow = async ({ video, data, duration, frames, inputDigest, onProgress }: CloudWorkflowInput): Promise<CloudRun> => {
  onProgress("uploading", 2);
  const digest = inputDigest ?? await calculateVideoDigest(video, (value) => onProgress("uploading", 2 + Math.round(value * 6)));
  const fallback = new File([JSON.stringify({ notice: "未提供比赛资料；视觉结果不得推断官方统计。" })], "visual-only.json", { type: "application/json" });
  const dataFile = data ?? fallback;
  const request: CreateJobRequest = {
    videoFileName: video.name,
    videoContentType: video.type === "video/quicktime" ? "video/quicktime" : "video/mp4",
    videoSizeBytes: video.size,
    inputDigest: digest,
    dataFileName: dataFile.name,
    dataContentType: dataFile.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/json",
    videoDurationSeconds: duration,
    videoWidth: frames[0]?.width ?? 1920,
    videoHeight: frames[0]?.height ?? 1080,
    sourceFps: 30,
    frameTimestamps: frames.map((frame) => frame.atSeconds)
  };
  const created = createJobResponseSchema.parse(await requestJson("/jobs", { method: "POST", body: JSON.stringify(request) }));
  let uploadedBytes = 0;
  const reportBytes = (bytes: number) => {
    uploadedBytes += bytes;
    onProgress("uploading", 10 + Math.round(Math.min(1, uploadedBytes / Math.max(1, video.size)) * 45));
  };
  const sideUploads = Promise.all([
    put(created.uploads.data.url, dataFile, request.dataContentType),
    ...created.uploads.frames.map((target, index) => put(target.url, frames[index]!.blob, "image/jpeg"))
  ]);
  if (created.uploads.video.mode === "single") {
    await put(created.uploads.video.url, video, request.videoContentType);
    reportBytes(video.size);
  } else {
    const parts = await uploadMultipart(video, created.job.id, created.uploads.video, reportBytes);
    await requestJson(`/jobs/${created.job.id}/video/complete`, {
      method: "POST", body: JSON.stringify({ uploadId: created.uploads.video.uploadId, parts })
    });
  }
  await sideUploads;
  onProgress("queued", 58);
  await requestJson(`/jobs/${created.job.id}/start`, { method: "POST", body: "{}" });

  const deadline = Date.now() + 55 * 60_000;
  while (Date.now() < deadline) {
    const job = jobSchema.parse(await requestJson(`/jobs/${created.job.id}`));
    onProgress(job.status, job.progress);
    if (job.status === "completed") {
      if (!job.analysis) throw new Error("AWS 任务完成但缺少分析结果");
      return { jobId: job.id, analysis: job.analysis, tracking: job.tracking, videoUrl: job.resultUrl };
    }
    if (job.status === "failed") throw new Error(job.error ?? "AWS 任务失败");
    await new Promise((resolve) => window.setTimeout(resolve, 2200));
  }
  throw new Error("AWS 任务等待超时，可稍后从作品库查看结果");
};
