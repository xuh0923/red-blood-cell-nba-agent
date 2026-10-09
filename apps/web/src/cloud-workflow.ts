import {
  createJobResponseSchema, jobSchema, type Analysis, type CreateJobRequest,
  type Job, type JobStatus
} from "@courtvision/contracts";
import type { ExtractedFrame } from "./video-frames";

const configuredApi = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");
export const cloudAvailable = Boolean(configuredApi) || !["localhost", "127.0.0.1"].includes(window.location.hostname);
const apiBase = configuredApi ?? "/api";

const requestJson = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error ?? `云端请求失败 (${response.status})`);
  return body;
};

const upload = async (url: string, body: Blob, contentType: string) => {
  const response = await fetch(url, { method: "PUT", headers: { "content-type": contentType }, body });
  if (!response.ok) throw new Error(`素材上传失败 (${response.status})`);
};

interface CloudWorkflowInput {
  video: File;
  data?: File;
  duration: number;
  frames: ExtractedFrame[];
  onProgress: (status: JobStatus, progress: number) => void;
}

const waitForResult = async (jobId: string, onProgress: CloudWorkflowInput["onProgress"]): Promise<Job> => {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const job = jobSchema.parse(await requestJson(`/jobs/${jobId}`));
    onProgress(job.status, job.progress);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(job.error ?? "AgentCore 分析失败");
    await new Promise((resolve) => window.setTimeout(resolve, 1800));
  }
  throw new Error("云端分析超时，请在任务记录中检查状态");
};

export const runCloudWorkflow = async ({ video, data, duration, frames, onProgress }: CloudWorkflowInput): Promise<Analysis> => {
  const fallbackData = new File([
    JSON.stringify({ notice: "未提供官方深度数据，只允许低置信度视觉估计。" })
  ], "visual-only.json", { type: "application/json" });
  const dataFile = data ?? fallbackData;
  const request: CreateJobRequest = {
    videoFileName: video.name,
    videoContentType: video.type === "video/quicktime" ? "video/quicktime" : "video/mp4",
    dataFileName: dataFile.name,
    dataContentType: dataFile.name.toLowerCase().endsWith(".csv") ? "text/csv" : "application/json",
    videoDurationSeconds: duration,
    frameTimestamps: frames.map((frame) => frame.atSeconds)
  };

  onProgress("uploading", 8);
  const created = createJobResponseSchema.parse(await requestJson("/jobs", {
    method: "POST",
    body: JSON.stringify(request)
  }));
  await Promise.all([
    upload(created.uploads.video.url, video, request.videoContentType),
    upload(created.uploads.data.url, dataFile, request.dataContentType),
    ...created.uploads.frames.map((target, index) => upload(target.url, frames[index]!.blob, "image/jpeg"))
  ]);
  onProgress("queued", 28);
  await requestJson(`/jobs/${created.job.id}/start`, { method: "POST", body: "{}" });
  const completed = await waitForResult(created.job.id, onProgress);
  if (!completed.analysis) throw new Error("云端任务完成但没有返回分析结果");
  return completed.analysis;
};
