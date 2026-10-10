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
    if (xfg !== undefined) {
      result.events[1]!.metric.value = xfg > 1 ? xfg / 100 : xfg;
      result.events[1]!.metric.source = `输入资料：${input.dataFileName} · xFG`;
    }
    if (gravity !== undefined) {
      result.events[0]!.metric.value = gravity;
      result.events[0]!.metric.source = `输入资料：${input.dataFileName} · gravity`;
    }
    if (impact !== undefined) {
      result.events[2]!.metric.value = impact;
      result.events[2]!.metric.source = `输入资料：${input.dataFileName} · winImpact`;
    }

    const availableKinds = new Set([
      ...(xfg === undefined ? [] : ["expected_field_goal_percentage"]),
      ...(gravity === undefined ? [] : ["on_ball_gravity"]),
      ...(impact === undefined ? [] : ["win_impact"])
    ]);
    result.events = result.events.filter((event) => availableKinds.has(event.metric.kind));
    const eventIds = new Set(result.events.map((event) => event.id));
    result.narration = result.narration.filter((cue) => (
      (cue.id === "n1" && eventIds.has("gravity-read"))
      || (cue.id === "n2" && eventIds.has("shot-quality"))
      || (cue.id === "n3" && eventIds.has("win-impact"))
    ));
    result.summary = availableKinds.size > 0
      ? `本地规则读取了 ${availableKinds.size} 项有来源指标；未提供的指标保持为空。`
      : "输入资料没有可计算的 xFG、引力或胜负影响指标。";

    result.warnings = [
      "当前由确定性本地分析器生成；结果只使用已加载的比赛资料。",
      ...(availableKinds.size === 0 ? ["没有可用指标时不会使用演示数据填充结果。"] : [])
    ];
    return analysisSchema.parse(result);
  }
}

