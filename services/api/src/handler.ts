import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, UploadPartCommand
} from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { trackingResultSchema, type Job } from "@courtvision/contracts";
import { createRouter } from "./router.js";

const region = process.env.AWS_REGION ?? "us-east-1";
const bucket = process.env.ASSET_BUCKET ?? "";
const table = process.env.JOBS_TABLE ?? "";
const stateMachineArn = process.env.STATE_MACHINE_ARN ?? "";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const sfn = new SFNClient({ region });

const scanJobs = async (filter: string, values: Record<string, unknown>, names?: Record<string, string>): Promise<Job[]> => {
  const result: Job[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: table, FilterExpression: filter, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ExclusiveStartKey: cursor }));
    result.push(...(page.Items ?? []) as Job[]);
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return result;
};

const route = createRouter({
  store: {
    put: async (job) => { await ddb.send(new PutCommand({ TableName: table, Item: job })); },
    get: async (id) => (await ddb.send(new GetCommand({ TableName: table, Key: { id } }))).Item as Job | undefined,
    listCompleted: () => scanJobs("#s = :status", { ":status": "completed" }, { "#s": "status" }),
    findByDigest: async (digest) => (await scanJobs("inputDigest = :digest", { ":digest": digest })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  },
  signer: {
    sign: (key, contentType) => getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 3600 }),
    createMultipart: async (key, contentType) => {
      const result = await s3.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
      if (!result.UploadId) throw new Error("S3 did not return an upload id");
      return result.UploadId;
    },
    signPart: (key, uploadId, partNumber) => getSignedUrl(s3, new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 3600 }),
    completeMultipart: async (key, uploadId, parts) => { await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } })); },
    abortMultipart: async (key, uploadId) => { await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })); },
    signDownload: (key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 3600 })
  },
  assets: {
    bucketName: bucket,
    readTracking: async (key) => {
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await response.Body?.transformToString("utf-8");
        return body ? trackingResultSchema.parse(JSON.parse(body)) : undefined;
      } catch { return undefined; }
    },
    list: async () => {
      const objects: Array<{ key: string; sizeBytes: number; lastModified: string; storageClass?: string }> = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        for (const item of page.Contents ?? []) if (item.Key && item.LastModified) objects.push({ key: item.Key, sizeBytes: item.Size ?? 0, lastModified: item.LastModified.toISOString(), storageClass: item.StorageClass });
        token = page.NextContinuationToken;
      } while (token);
      return objects;
    }
  },
  workflow: {
    start: async (job) => { await sfn.send(new StartExecutionCommand({ stateMachineArn, name: `job-${job.id}`, input: JSON.stringify(job) })); }
  }
});

export const handler: APIGatewayProxyHandlerV2 = async (event) => route({
  method: event.requestContext.http.method,
  path: event.rawPath.replace(/^\/api(?=\/)/, ""),
  body: event.body
});
