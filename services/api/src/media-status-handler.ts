import type { EventBridgeHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Job } from "@courtvision/contracts";

interface MediaEventDetail {
  status: "COMPLETE" | "ERROR" | "CANCELED";
  jobId: string;
  userMetadata?: { jobId?: string };
  errorMessage?: string;
}

const table = process.env.JOBS_TABLE ?? "";
const mediaBase = (process.env.MEDIA_BASE_URL ?? "").replace(/\/$/, "");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }));

export const handler: EventBridgeHandler<"MediaConvert Job State Change", MediaEventDetail, void> = async (event) => {
  const jobId = event.detail.userMetadata?.jobId;
  if (!jobId) return;
  const job = (await ddb.send(new GetCommand({ TableName: table, Key: { id: jobId } }))).Item as Job | undefined;
  if (!job) return;
  const complete = event.detail.status === "COMPLETE";
  const values: Record<string, unknown> = complete ? {
    status: "completed", progress: 100, mediaStatus: "complete",
    resultUrl: `${mediaBase}/${job.playbackKey}`, updatedAt: new Date().toISOString()
  } : {
    status: "failed", progress: 100, mediaStatus: "error",
    error: event.detail.errorMessage ?? `MediaConvert ${event.detail.status}`,
    updatedAt: new Date().toISOString()
  };
  const entries = Object.entries(values);
  await ddb.send(new UpdateCommand({ TableName: table, Key: { id: jobId },
    UpdateExpression: `SET ${entries.map((_, index) => `#k${index} = :v${index}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], index) => [`#k${index}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])) }));
};
