import { ConverseCommand, type BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { analysisSchema, type Analysis } from "@courtvision/contracts";
import { demoAnalysis } from "@courtvision/contracts/fixtures";

export interface AnalyzeInput {
  videoFileName: string;
  dataFileName: string;
  structuredData: unknown;
  frameDescriptions?: Array<{ atSeconds: number; description: string }>;
}

export interface BasketballAnalyzer {
  analyze(input: AnalyzeInput): Promise<Analysis>;
}

const numericValue = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

const findNumber = (input: unknown, names: string[]): number | undefined => {
  const wanted = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const visit = (value: unknown): number | undefined => {
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) {
        const found = visit(item);
        if (found !== undefined) return found;
      }
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (wanted.includes(normalized)) {
          const found = numericValue(child);
          if (found !== undefined) return found;
        }
        const nested = visit(child);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  return visit(input);
};

export class LocalRulesAnalyzer implements BasketballAnalyzer {
  async analyze(input: AnalyzeInput): Promise<Analysis> {
    const result = structuredClone(demoAnalysis);
    result.provenance = { videoFile: input.videoFileName, dataFile: input.dataFileName };

    const xfg = findNumber(input.structuredData, ["xfg", "xfgpct", "expectedfg", "expectedfieldgoalpercentage"]);
    const gravity = findNumber(input.structuredData, ["gravity", "onballgravity", "gravityscore"]);
    const impact = findNumber(input.structuredData, ["winimpact", "impact", "winprobabilityadded"]);
    if (xfg !== undefined) result.events[1]!.metric.value = xfg > 1 ? xfg / 100 : xfg;
    if (gravity !== undefined) result.events[0]!.metric.value = gravity;
    if (impact !== undefined) result.events[2]!.metric.value = impact;

    result.warnings = [
      "当前由确定性本地分析器生成，仅用于开发和端到端测试。",
      "正式云端流程必须由 Bedrock AgentCore 产出并保留输入证据。"
    ];
    return analysisSchema.parse(result);
  }
}

export const analysisSystemPrompt = `你是 NBA 深度赛场分析 Agent。只使用给定数据和画面描述，不得虚构逐帧轨迹。
输出严格 JSON，必须符合 Analysis v1：包含 summary、events、narration、warnings、provenance。
优先解释预期命中率、持球/无球引力和胜负影响。每个 event 必须有时间范围、单一核心指标和 evidence。
generatedBy 必须是 bedrock。信息不足时写入 warnings，不要猜测。`;

export class BedrockAnalyzer implements BasketballAnalyzer {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly modelId = "global.anthropic.claude-sonnet-4-6"
  ) {}

  async analyze(input: AnalyzeInput): Promise<Analysis> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: analysisSystemPrompt }],
      messages: [{
        role: "user",
        content: [{ text: JSON.stringify(input) }]
      }],
      inferenceConfig: { maxTokens: 4096, temperature: 0.1 }
    }));
    const text = response.output?.message?.content?.find((part) => "text" in part)?.text;
    if (!text) throw new Error("Bedrock returned no analysis text");
    const json = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    return analysisSchema.parse(JSON.parse(json));
  }
}
