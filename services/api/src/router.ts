import { createJobRequestSchema, type Job } from "@courtvision/contracts";

export interface Request {
  method: string;
  path: string;
  body?: string;
}

export interface Response {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
}

export interface JobStore {
  put(job: Job): Promise<void>;
  get(id: string): Promise<Job | undefined>;
}

export interface UploadSigner {
  sign(key: string, contentType: string): Promise<string>;
}

export interface WorkflowStarter {
  start(job: Job): Promise<void>;
}

interface Dependencies {
  store: JobStore;
  signer: UploadSigner;
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

export const createRouter = ({ store, signer, workflow, now = () => new Date(), uuid = () => crypto.randomUUID() }: Dependencies) => {
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return json(204, {});

    if (request.method === "POST" && request.path === "/jobs") {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(request.body ?? "{}");
      } catch {
        return json(400, { error: "请求正文不是有效 JSON" });
      }
      const parsed = createJobRequestSchema.safeParse(parsedBody);
      if (!parsed.success) return json(400, { error: "上传参数无效", details: parsed.error.flatten() });

      const id = uuid();
      const timestamp = now().toISOString();
      const videoKey = `input/${id}/video/${safeName(parsed.data.videoFileName)}`;
      const dataKey = `input/${id}/data/${safeName(parsed.data.dataFileName)}`;
      const frames = parsed.data.frameTimestamps.map((atSeconds, index) => ({
        key: `input/${id}/frames/frame-${String(index).padStart(2, "0")}.jpg`,
        atSeconds
      }));
      const job: Job = {
        id, status: "uploading", progress: 5, createdAt: timestamp, updatedAt: timestamp, videoKey, dataKey,
        videoDurationSeconds: parsed.data.videoDurationSeconds,
        frames
      };
      await store.put(job);
      const [videoUrl, dataUrl, frameUrls] = await Promise.all([
        signer.sign(videoKey, parsed.data.videoContentType),
        signer.sign(dataKey, parsed.data.dataContentType),
        Promise.all(frames.map((frame) => signer.sign(frame.key, "image/jpeg")))
      ]);
      return json(201, {
        job,
        uploads: {
          video: { url: videoUrl, key: videoKey },
          data: { url: dataUrl, key: dataKey },
          frames: frames.map((frame, index) => ({ ...frame, url: frameUrls[index] }))
        }
      });
    }

    const getMatch = request.path.match(/^\/jobs\/([0-9a-f-]+)$/i);
    if (request.method === "GET" && getMatch?.[1]) {
      const job = await store.get(getMatch[1]);
      return job ? json(200, job) : json(404, { error: "任务不存在" });
    }

    const startMatch = request.path.match(/^\/jobs\/([0-9a-f-]+)\/start$/i);
    if (request.method === "POST" && startMatch?.[1]) {
      const job = await store.get(startMatch[1]);
      if (!job) return json(404, { error: "任务不存在" });
      if (job.status !== "uploading") return json(409, { error: "任务当前状态不能启动" });
      const updated = { ...job, status: "queued" as const, progress: 10, updatedAt: now().toISOString() };
      await store.put(updated);
      await workflow.start(updated);
      return json(202, updated);
    }

    return json(404, { error: "接口不存在" });
  };
};
