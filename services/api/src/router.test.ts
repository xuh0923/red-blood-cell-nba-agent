import { describe, expect, it } from "vitest";
import type { Job } from "@courtvision/contracts";
import { createRouter } from "./router.js";

const id = "11111111-1111-4111-8111-111111111111";

const setup = () => {
  const jobs = new Map<string, Job>();
  const starts: Job[] = [];
  const route = createRouter({
    store: {
      put: async (job) => { jobs.set(job.id, job); },
      get: async (jobId) => jobs.get(jobId)
    },
    signer: { sign: async (key) => `https://upload.test/${encodeURIComponent(key)}` },
    workflow: { start: async (job) => { starts.push(job); } },
    uuid: () => id,
    now: () => new Date("2026-10-08T00:00:00.000Z")
  });
  return { route, jobs, starts };
};

describe("job API router", () => {
  it("creates a UUID with the default Node crypto implementation", async () => {
    const route = createRouter({
      store: { put: async () => undefined, get: async () => undefined },
      signer: { sign: async (key) => `https://upload.test/${encodeURIComponent(key)}` },
      workflow: { start: async () => undefined }
    });
    const response = await route({
      method: "POST", path: "/jobs",
      body: JSON.stringify({
        videoFileName: "clip.mp4", videoContentType: "video/mp4",
        dataFileName: "events.json", dataContentType: "application/json",
        videoDurationSeconds: 20, frameTimestamps: [2, 8, 14]
      })
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body).job.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("creates upload URLs and sanitizes file names", async () => {
    const { route, jobs } = setup();
    const response = await route({
      method: "POST", path: "/jobs",
      body: JSON.stringify({
        videoFileName: "训练 视频.mp4", videoContentType: "video/mp4",
        dataFileName: "events.json", dataContentType: "application/json",
        videoDurationSeconds: 20, frameTimestamps: [2, 8, 14]
      })
    });
    expect(response.statusCode).toBe(201);
    expect(jobs.get(id)?.videoKey).not.toContain(" ");
    expect(jobs.get(id)?.frames).toHaveLength(3);
    expect(JSON.parse(response.body).uploads.frames).toHaveLength(3);
  });

  it("starts only an existing uploading job", async () => {
    const { route, starts } = setup();
    await route({
      method: "POST", path: "/jobs",
      body: JSON.stringify({
        videoFileName: "clip.mp4", videoContentType: "video/mp4",
        dataFileName: "events.json", dataContentType: "application/json",
        videoDurationSeconds: 20, frameTimestamps: [2, 8, 14]
      })
    });
    const response = await route({ method: "POST", path: `/jobs/${id}/start` });
    expect(response.statusCode).toBe(202);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.status).toBe("queued");
  });

  it("rejects unsupported upload types", async () => {
    const { route } = setup();
    const response = await route({
      method: "POST", path: "/jobs",
      body: JSON.stringify({
        videoFileName: "clip.exe", videoContentType: "application/octet-stream",
        dataFileName: "events.json", dataContentType: "application/json",
        videoDurationSeconds: 20, frameTimestamps: [2, 8, 14]
      })
    });
    expect(response.statusCode).toBe(400);
  });
});
