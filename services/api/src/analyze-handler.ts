import type { Handler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { CreateJobCommand, MediaConvertClient } from "@aws-sdk/client-mediaconvert";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LocalRulesAnalyzer } from "@courtvision/agent";
import { gameStatsTimelineSchema, trackingResultSchema, type Analysis } from "@courtvision/contracts";

interface AnalyzeEvent {
  jobId: string;
  videoKey: string;
  videoFileName?: string;
  dataKey: string;
  videoDurationSeconds: number;
  trackingKey?: string;
}

const region = process.env.AWS_REGION ?? "us-east-1";
const table = process.env.JOBS_TABLE ?? "";
const bucket = process.env.ASSET_BUCKET ?? "";
const mediaRole = process.env.MEDIACONVERT_ROLE_ARN ?? "";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const s3 = new S3Client({ region });
const mediaConvert = new MediaConvertClient({ region });

const updateJob = async (jobId: string, values: Record<string, unknown>) => {
  const entries = Object.entries({ ...values, updatedAt: new Date().toISOString() });
  await ddb.send(new UpdateCommand({ TableName: table, Key: { id: jobId },
    UpdateExpression: `SET ${entries.map((_, index) => `#k${index} = :v${index}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], index) => [`#k${index}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], index) => [`:v${index}`, value])) }));
};

const readText = async (key: string): Promise<string> => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await response.Body?.transformToString("utf-8") ?? "";
};
const parseData = (text: string): unknown => {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch { return { sourceText: text.slice(0, 180_000) }; }
};

export const handler: Handler<AnalyzeEvent, { analysis: Analysis; mediaJobId: string }> = async (event) => {
  try {
    await updateJob(event.jobId, { status: "rendering", progress: 66 });
    const [dataText, trackingText] = await Promise.all([
      readText(event.dataKey),
      event.trackingKey ? readText(event.trackingKey) : Promise.resolve("")
    ]);
    const structuredData = parseData(dataText);
    const tracking = trackingText ? trackingResultSchema.parse(JSON.parse(trackingText)) : undefined;
    const analyzer = new LocalRulesAnalyzer();
    const analysis = await analyzer.analyze({
      videoFileName: event.videoFileName ?? event.videoKey.split("/").at(-1) ?? "video.mp4",
      dataFileName: event.dataKey.split("/").at(-1) ?? "data.json",
      structuredData
    });
    analysis.summary = tracking
      ? `AWS 连续视觉生成 ${tracking.tracks.length} 条候选人物轨迹；姓名与标准球场路线仍需号码识别和球场标定确认。`
      : analysis.summary;
    analysis.warnings = [...(tracking?.warnings ?? []), ...analysis.warnings];
    const statsCandidates = [structuredData, structuredData && typeof structuredData === "object" ? (structuredData as Record<string, unknown>).stats : undefined];
    const stats = statsCandidates.map((candidate) => gameStatsTimelineSchema.safeParse(candidate)).find((candidate) => candidate.success)?.data;
    const analysisKey = `jobs/${event.jobId}/analysis.json`;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: analysisKey, Body: JSON.stringify(analysis), ContentType: "application/json" }));

    const sourceName = event.videoKey.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? event.jobId;
    const playbackKey = `media/${event.jobId}/playback/${sourceName}-1080p.mp4`;
    const mediaJob = await mediaConvert.send(new CreateJobCommand({
      Role: mediaRole,
      UserMetadata: { jobId: event.jobId },
      Settings: {
        TimecodeConfig: { Source: "ZEROBASED" },
        Inputs: [{
          FileInput: `s3://${bucket}/${event.videoKey}`,
          AudioSelectors: { "Audio Selector 1": { DefaultSelection: "DEFAULT" } },
          VideoSelector: {}
        }],
        OutputGroups: [{
          Name: "Fast playback MP4",
          OutputGroupSettings: { Type: "FILE_GROUP_SETTINGS", FileGroupSettings: { Destination: `s3://${bucket}/media/${event.jobId}/playback/` } },
          Outputs: [{
            NameModifier: "-1080p",
            ContainerSettings: { Container: "MP4", Mp4Settings: { MoovPlacement: "PROGRESSIVE_DOWNLOAD" } },
            VideoDescription: {
              Width: 1920, Height: 1080, ScalingBehavior: "DEFAULT", TimecodeInsertion: "DISABLED",
              CodecSettings: { Codec: "H_264", H264Settings: {
                RateControlMode: "QVBR", MaxBitrate: 8_000_000,
                QvbrSettings: { QvbrQualityLevel: 8 }, CodecProfile: "HIGH",
                FramerateControl: "INITIALIZE_FROM_SOURCE", GopSize: 2, GopSizeUnits: "SECONDS"
              } }
            },
            AudioDescriptions: [{ CodecSettings: { Codec: "AAC", AacSettings: { Bitrate: 128_000, CodingMode: "CODING_MODE_2_0", SampleRate: 48_000 } } }]
          }]
        }]
      },
      StatusUpdateInterval: "SECONDS_10"
    }));
    if (!mediaJob.Job?.Id) throw new Error("MediaConvert 未返回任务编号");
    await updateJob(event.jobId, {
      status: "publishing", progress: 88, analysis, analysisKey, ...(stats ? { stats } : {}),
      mediaJobId: mediaJob.Job.Id, mediaStatus: "processing", playbackKey
    });
    return { analysis, mediaJobId: mediaJob.Job.Id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "云端分析失败";
    await updateJob(event.jobId, { status: "failed", progress: 100, error: message, mediaStatus: "error" });
    throw error;
  }
};
