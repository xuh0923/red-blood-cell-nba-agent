import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetLabelDetectionCommand, RekognitionClient, StartLabelDetectionCommand } from "@aws-sdk/client-rekognition";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { buildRekognitionTracking, type LabelDetectionLike } from "./rekognition-tracking.js";

interface VisionEvent {
  action: "start" | "poll";
  jobId: string;
  videoKey: string;
  videoDurationSeconds: number;
  videoWidth?: number;
  videoHeight?: number;
  sourceFps?: number;
  labelJobId?: string;
}
interface VisionState extends VisionEvent { visionStatus: "IN_PROGRESS" | "SUCCEEDED" | "FAILED"; trackingKey?: string; warning?: string }

const region = process.env.AWS_REGION ?? "us-east-1";
const bucket = process.env.ASSET_BUCKET ?? "";
const table = process.env.JOBS_TABLE ?? "";
const rekognition = new RekognitionClient({ region });
const s3 = new S3Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const updateJob = async (jobId: string, values: Record<string, unknown>) => {
  const entries = Object.entries({ ...values, updatedAt: new Date().toISOString() });
  await ddb.send(new UpdateCommand({ TableName: table, Key: { id: jobId },
    UpdateExpression: `SET ${entries.map((_, index) => `#k${index} = :v${index}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], index) => [`#k${index}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])) }));
};

const fail = async (event: VisionEvent, error: unknown): Promise<VisionState> => {
  const warning = `AWS 连续视觉识别失败：${error instanceof Error ? error.message : "未知错误"}`;
  await updateJob(event.jobId, { status: "failed", progress: 100, error: warning, visionProvider: "rekognition-video" });
  return { ...event, visionStatus: "FAILED", warning };
};

const start = async (event: VisionEvent): Promise<VisionState> => {
  try {
    await updateJob(event.jobId, { status: "analyzing", progress: 18, visionProvider: "rekognition-video" });
    const response = await rekognition.send(new StartLabelDetectionCommand({
      Video: { S3Object: { Bucket: bucket, Name: event.videoKey } }, JobTag: `courtvision-${event.jobId}`, MinConfidence: 35
    }));
    if (!response.JobId) throw new Error("Rekognition 未返回任务编号");
    return { ...event, visionStatus: "IN_PROGRESS", labelJobId: response.JobId };
  } catch (error) { return fail(event, error); }
};

const poll = async (event: VisionEvent): Promise<VisionState> => {
  if (!event.labelJobId) return fail(event, new Error("缺少 Rekognition 任务编号"));
  try {
    const status = await rekognition.send(new GetLabelDetectionCommand({ JobId: event.labelJobId, MaxResults: 1 }));
    if (status.JobStatus === "FAILED") return fail(event, new Error(status.StatusMessage ?? "Rekognition 任务失败"));
    if (status.JobStatus !== "SUCCEEDED") {
      await updateJob(event.jobId, { progress: 32 });
      return { ...event, visionStatus: "IN_PROGRESS" };
    }
    const labels: LabelDetectionLike[] = [];
    let nextToken: string | undefined;
    do {
      const page = await rekognition.send(new GetLabelDetectionCommand({ JobId: event.labelJobId, SortBy: "TIMESTAMP", MaxResults: 1000, NextToken: nextToken }));
      labels.push(...(page.Labels ?? []));
      nextToken = page.NextToken;
    } while (nextToken);
    const tracking = buildRekognitionTracking(labels, { durationSeconds: event.videoDurationSeconds, width: event.videoWidth, height: event.videoHeight, sourceFps: event.sourceFps });
    const trackingKey = `jobs/${event.jobId}/tracking.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: trackingKey, Body: JSON.stringify(tracking), ContentType: "application/json" }));
    await updateJob(event.jobId, { progress: 55, trackingKey, visionProvider: "rekognition-video" });
    return { ...event, visionStatus: "SUCCEEDED", trackingKey };
  } catch (error) { return fail(event, error); }
};

export const handler: Handler<VisionEvent, VisionState> = async (event) => event.action === "start" ? start(event) : poll(event);
