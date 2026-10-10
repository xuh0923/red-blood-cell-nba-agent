import { describe, expect, it } from "vitest";
import type { Job } from "@courtvision/contracts";
import { createRouter } from "./router.js";

const id = "11111111-1111-4111-8111-111111111111";
const digest = `sha256:${"a".repeat(64)}`;

const setup = () => {
  const jobs = new Map<string, Job>();
  const starts: Job[] = [];
  const route = createRouter({
    store: {
      put: async (job) => { jobs.set(job.id, job); },
      get: async (jobId) => jobs.get(jobId),
      listCompleted: async () => [...jobs.values()].filter((job) => job.status === "completed"),
      findByDigest: async (value) => [...jobs.values()].find((job) => job.inputDigest === value)
    },
    signer: {
      sign: async (key) => `https://upload.test/${encodeURIComponent(key)}`,
      createMultipart: async () => "upload-1",
      signPart: async (_key, _uploadId, partNumber) => `https://upload.test/part/${partNumber}`,
      completeMultipart: async () => undefined,
      abortMultipart: async () => undefined,
      signDownload: async (key) => `https://download.test/${encodeURIComponent(key)}`
    },
    assets: { bucketName: "test-assets", list: async () => [], readTracking: async () => undefined },
    workflow: { start: async (job) => { starts.push(job); } },
    uuid: () => id,
    now: () => new Date("2026-10-10T00:00:00.000Z")
  });
  return { route, jobs, starts };
};

const request = (size = 84 * 1024 * 1024) => ({
  videoFileName: "training.mp4",
  videoContentType: "video/mp4" as const,
  videoSizeBytes: size,
  inputDigest: digest,
  dataFileName: "events.json",
  dataContentType: "application/json" as const,
  videoDurationSeconds: 22,
  videoWidth: 1920,
  videoHeight: 1080,
  sourceFps: 60,
  frameTimestamps: [2, 8, 14]
});

describe("AWS job router", () => {
  it("uses multipart upload for the organizer-sized training video", async () => {
    const { route, jobs } = setup();
    const response = await route({ method: "POST", path: "/jobs", body: JSON.stringify(request()) });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.uploads.video.mode).toBe("multipart");
    expect(body.uploads.video.parts).toHaveLength(11);
    expect(jobs.get(id)?.videoKey).toContain("input/videos/");
  });

  it("starts only a stored uploading job", async () => {
    const { route, starts } = setup();
    await route({ method: "POST", path: "/jobs", body: JSON.stringify(request()) });
    const response = await route({ method: "POST", path: `/jobs/${id}/start` });
    expect(response.statusCode).toBe(202);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.status).toBe("queued");
  });

  it("rejects a duplicate content digest before allocating another upload", async () => {
    const { route } = setup();
    await route({ method: "POST", path: "/jobs", body: JSON.stringify(request()) });
    const response = await route({ method: "POST", path: "/jobs", body: JSON.stringify(request()) });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).code).toBe("DUPLICATE_VIDEO");
  });
});
