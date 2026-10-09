import {
  trackingResultSchema,
  type JobStatus,
  type TrackingResult
} from "@courtvision/contracts";

interface LocalJob {
  id: string;
  status: JobStatus;
  progress: number;
  error?: string;
}

interface LocalWorkflowInput {
  video: File;
  data?: File;
  roster?: File;
  onProgress: (status: JobStatus, progress: number) => void;
}

export interface LocalVisionRun {
  jobId: string;
  tracking: TrackingResult;
}

const requestJson = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`/local-api${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (body as { detail?: string; error?: string }).detail ?? (body as { error?: string }).error;
    throw new Error(detail ?? `本地视觉服务请求失败 (${response.status})`);
  }
  return body;
};

const parseJob = (value: unknown): LocalJob => {
  if (!value || typeof value !== "object") throw new Error("本地视觉服务返回了无效任务");
  const job = value as Partial<LocalJob>;
  if (!job.id || !job.status || typeof job.progress !== "number") throw new Error("本地任务缺少必要字段");
  return job as LocalJob;
};

export const checkLocalVision = async (): Promise<{ device: string; model: string }> => {
  return await requestJson("/health") as { device: string; model: string };
};

export const runLocalVisionWorkflow = async ({ video, data, roster, onProgress }: LocalWorkflowInput): Promise<LocalVisionRun> => {
  const form = new FormData();
  form.append("video", video);
  if (data) form.append("data", data);
  if (roster) form.append("roster", roster);
  let job = parseJob(await requestJson("/jobs", { method: "POST", body: form }));
  onProgress(job.status, job.progress);

  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    job = parseJob(await requestJson(`/jobs/${job.id}`));
    onProgress(job.status, job.progress);
    if (job.status === "failed") throw new Error(job.error ?? "本地连续视觉处理失败");
    if (job.status === "completed") {
      return { jobId: job.id, tracking: trackingResultSchema.parse(await requestJson(`/jobs/${job.id}/tracking`)) };
    }
  }
  throw new Error("本地视觉处理超时，请检查视觉服务终端日志");
};

export const updateLocalTrackIdentity = async (jobId: string, trackId: number, playerId: string | null): Promise<TrackingResult> => {
  return trackingResultSchema.parse(await requestJson(`/jobs/${jobId}/identities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignments: [{ trackId, playerId }] })
  }));
};
