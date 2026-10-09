import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ConverseCommand, BedrockRuntimeClient, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { analysisSchema, type Analysis } from "@courtvision/contracts";

interface RuntimeInput {
  jobId: string;
  bucket: string;
  videoKey: string;
  dataKey: string;
  videoDurationSeconds: number;
  frames: Array<{ key: string; atSeconds: number }>;
}

const region = process.env.AWS_REGION ?? "us-east-1";
const modelId = process.env.MODEL_ID ?? "global.anthropic.claude-sonnet-4-6";
const s3 = new S3Client({ region });
const bedrock = new BedrockRuntimeClient({ region });

const systemPrompt = `你是部署在 Amazon Bedrock AgentCore 中的 NBA 视频分析 Agent。
你会收到按时间排序的比赛关键帧和一份结构化/文本赛事数据。你的任务是生成可执行的 Analysis v1 JSON。

准确性规则：
1. 只描述关键帧中能看见的站位、持球、出手、防守收缩和结果，不声称知道采样帧之间的逐帧轨迹。
2. 预期命中率、球员引力、胜负影响优先取赛事数据。数据没有提供时允许给视觉估计，但 source 必须写“视觉模型估计（非官方赛事数据）”，confidence 不得高于 0.5，warnings 必须说明。
3. 不确定球员姓名时使用“持球人”“出手球员”“弱侧球员”，禁止猜姓名。
4. evidence 必须区分“画面证据”和“数据证据”。每个事件只突出一个最有解释力的指标。
5. event 时间必须在视频时长内，并靠近实际提供的关键帧时间。
6. summary 不超过 120 个汉字；title 不超过 14 个汉字；explanation 必须是 35–70 个汉字的一句话；每条 evidence 不超过 60 个汉字。总事件数控制在 3–5 个，避免重复指标和冗长复述。

只输出 JSON，不要 Markdown。结构必须是：
{"version":"1.0","summary":"...","generatedBy":"agentcore","events":[{"id":"...","startSeconds":0,"endSeconds":1,"title":"...","explanation":"...","player":"...","metric":{"kind":"expected_field_goal_percentage|on_ball_gravity|off_ball_gravity|win_impact","value":0.5,"unit":"percent|index|points","label":"...","source":"...","confidence":0.5},"anchor":"top-left|top-right|bottom-left|bottom-right","accent":"cyan|amber|red|green","evidence":["画面证据：..."]}],"narration":[{"id":"...","startSeconds":0,"text":"...","emotion":"neutral|focused|excited|surprised|happy"}],"warnings":[],"provenance":{"videoFile":"...","dataFile":"..."}}`;

const requiredString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
};

const parseInput = (value: unknown): RuntimeInput => {
  if (!value || typeof value !== "object") throw new Error("request body must be an object");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.frames) || input.frames.length < 3 || input.frames.length > 8) {
    throw new Error("frames must contain 3 to 8 items");
  }
  const duration = Number(input.videoDurationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("videoDurationSeconds must be positive");
  return {
    jobId: requiredString(input.jobId, "jobId"),
    bucket: requiredString(input.bucket, "bucket"),
    videoKey: requiredString(input.videoKey, "videoKey"),
    dataKey: requiredString(input.dataKey, "dataKey"),
    videoDurationSeconds: duration,
    frames: input.frames.map((frame, index) => {
      const item = frame as Record<string, unknown>;
      const atSeconds = Number(item.atSeconds);
      if (!Number.isFinite(atSeconds) || atSeconds < 0 || atSeconds > duration) throw new Error(`invalid frame time at ${index}`);
      return { key: requiredString(item.key, `frames[${index}].key`), atSeconds };
    })
  };
};

const readText = async (bucket: string, key: string): Promise<string> => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await response.Body?.transformToString("utf-8"))?.slice(0, 180_000) ?? "";
};

const readBytes = async (bucket: string, key: string): Promise<Uint8Array> => {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error(`empty S3 object: ${key}`);
  return response.Body.transformToByteArray();
};

const jsonFromText = (text: string): unknown => {
  const clean = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model response did not contain JSON");
  return JSON.parse(clean.slice(start, end + 1));
};

const normalize = (raw: unknown, input: RuntimeInput): Analysis => {
  if (!raw || typeof raw !== "object") throw new Error("analysis is not an object");
  const result = raw as Record<string, unknown>;
  result.version = "1.0";
  result.generatedBy = "agentcore";
  result.provenance = {
    videoFile: input.videoKey.split("/").at(-1) ?? input.videoKey,
    dataFile: input.dataKey.split("/").at(-1) ?? input.dataKey
  };
  if (Array.isArray(result.events)) {
    result.events = result.events.map((event) => {
      if (!event || typeof event !== "object") return event;
      const item = event as Record<string, unknown>;
      item.startSeconds = Math.max(0, Math.min(input.videoDurationSeconds - 0.1, Number(item.startSeconds) || 0));
      item.endSeconds = Math.max(Number(item.startSeconds) + 0.1, Math.min(input.videoDurationSeconds, Number(item.endSeconds) || Number(item.startSeconds) + 2));
      return item;
    });
  }
  return analysisSchema.parse(result);
};

const invokeModel = async (input: RuntimeInput): Promise<Analysis> => {
  const [dataText, frameBytes] = await Promise.all([
    readText(input.bucket, input.dataKey),
    Promise.all(input.frames.map((frame) => readBytes(input.bucket, frame.key)))
  ]);

  const content: ContentBlock[] = [{
    text: `视频时长：${input.videoDurationSeconds.toFixed(2)} 秒\n视频文件：${input.videoKey}\n数据文件：${input.dataKey}\n赛事数据如下：\n${dataText || "（未提供赛事数据，只能进行低置信度视觉估计）"}`
  }];
  input.frames.forEach((frame, index) => {
    content.push({ text: `关键帧 ${index + 1}，时间 ${frame.atSeconds.toFixed(2)} 秒` });
    content.push({ image: { format: "jpeg", source: { bytes: frameBytes[index]! } } });
  });

  const response = await bedrock.send(new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{ role: "user", content }],
    inferenceConfig: { maxTokens: 5000, temperature: 0.1 }
  }));
  const text = response.output?.message?.content?.find((part) => "text" in part)?.text;
  if (!text) throw new Error("Bedrock returned no text");
  return normalize(jsonFromText(text), input);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("request payload is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};

const sendJson = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ping") {
    sendJson(response, 200, { status: "Healthy" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/invocations") {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  try {
    const input = parseInput(await readBody(request));
    const analysis = await invokeModel(input);
    sendJson(response, 200, analysis);
  } catch (error) {
    console.error("analysis failed", error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : "analysis failed" });
  }
});

server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log(`CourtVision AgentCore runtime listening on port ${process.env.PORT ?? 8080}`);
});
