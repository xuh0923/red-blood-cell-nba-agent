import type { Handler } from "aws-lambda";
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { analysisSchema, type Analysis } from "@courtvision/contracts";

interface AnalyzeEvent {
  jobId: string;
  videoKey: string;
  dataKey: string;
  videoDurationSeconds: number;
  frames: Array<{ key: string; atSeconds: number }>;
}

const region = process.env.AWS_REGION ?? "us-east-1";
const table = process.env.JOBS_TABLE ?? "";
const bucket = process.env.ASSET_BUCKET ?? "";
const runtimeArn = process.env.AGENT_RUNTIME_ARN ?? "";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const agentcore = new BedrockAgentCoreClient({ region });

const updateJob = async (jobId: string, values: Record<string, unknown>) => {
  const entries = Object.entries({ ...values, updatedAt: new Date().toISOString() });
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { id: jobId },
    UpdateExpression: `SET ${entries.map((_, index) => `#k${index} = :v${index}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], index) => [`#k${index}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value]))
  }));
};

export const handler: Handler<AnalyzeEvent, { analysis: Analysis }> = async (event) => {
  await updateJob(event.jobId, { status: "analyzing", progress: 48 });
  try {
    const response = await agentcore.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      qualifier: "DEFAULT",
      runtimeSessionId: `courtvision-${event.jobId}`,
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(JSON.stringify({ ...event, bucket }))
    }));
    const responseText = await response.response?.transformToString("utf-8");
    if (!responseText) throw new Error("AgentCore returned an empty response");
    if ((response.statusCode ?? 500) >= 400) throw new Error(`AgentCore failed (${response.statusCode}): ${responseText}`);
    const analysis = analysisSchema.parse(JSON.parse(responseText));
    const analysisKey = `jobs/${event.jobId}/analysis.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: analysisKey,
      Body: JSON.stringify(analysis),
      ContentType: "application/json"
    }));
    await updateJob(event.jobId, { status: "completed", progress: 100, analysis, analysisKey });
    return { analysis };
  } catch (error) {
    const message = error instanceof Error ? error.message : "AgentCore analysis failed";
    await updateJob(event.jobId, { status: "failed", progress: 100, error: message });
    throw error;
  }
};
