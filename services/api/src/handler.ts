import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Job } from "@courtvision/contracts";
import { createRouter } from "./router.js";

const region = process.env.AWS_REGION ?? "us-east-1";
const bucket = process.env.ASSET_BUCKET ?? "";
const table = process.env.JOBS_TABLE ?? "";
const stateMachineArn = process.env.STATE_MACHINE_ARN ?? "";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const sfn = new SFNClient({ region });

const route = createRouter({
  store: {
    put: async (job) => { await ddb.send(new PutCommand({ TableName: table, Item: job })); },
    get: async (id) => (await ddb.send(new GetCommand({ TableName: table, Key: { id } }))).Item as Job | undefined
  },
  signer: {
    sign: (key, contentType) => getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 900 })
  },
  workflow: {
    start: async (job) => {
      await sfn.send(new StartExecutionCommand({
        stateMachineArn,
        name: `job-${job.id}`,
        input: JSON.stringify({
          jobId: job.id,
          videoKey: job.videoKey,
          dataKey: job.dataKey,
          videoDurationSeconds: job.videoDurationSeconds,
          frames: job.frames
        })
      }));
    }
  }
});

export const handler: APIGatewayProxyHandlerV2 = async (event) => route({
  method: event.requestContext.http.method,
  path: event.rawPath.replace(/^\/api(?=\/)/, ""),
  body: event.body
});
