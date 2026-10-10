import type { Analysis, GameStatsTimeline, JobStatus } from "@courtvision/contracts";
import { analysisSchema, gameStatsTimelineSchema } from "@courtvision/contracts";
import { demoAnalysis } from "@courtvision/contracts/fixtures";

export interface WorkflowStep {
  status: JobStatus;
  progress: number;
  label: string;
}

export const workflowSteps: WorkflowStep[] = [
  { status: "uploading", progress: 12, label: "校验输入" },
  { status: "extracting_frames", progress: 30, label: "读取视频" },
  { status: "analyzing", progress: 56, label: "连续视觉分析" },
  { status: "rendering", progress: 78, label: "生成可视化叠加" },
  { status: "publishing", progress: 93, label: "准备播放结果" },
  { status: "completed", progress: 100, label: "分析完成" }
];

const findMetric = (value: unknown, aliases: string[]): number | undefined => {
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) {
      const result = findMetric(item, aliases);
      if (result !== undefined) return result;
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (aliases.includes(normalized)) {
        const number = Number(child);
        if (Number.isFinite(number)) return number;
      }
      const result = findMetric(child, aliases);
      if (result !== undefined) return result;
    }
  }
  return undefined;
};

const normalizeKey = (value: string): string => value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

const coerceValue = (value: string): string | number | boolean => {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
};

/** Parse RFC 4180 style CSV without losing quoted commas or line breaks. */
const parseCsv = (content: string): Array<Record<string, string | number | boolean>> => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) return [];
  const headers = headerRow.map((header, index) => header.trim() || `field_${index}`);
  return dataRows.map((values) => Object.fromEntries(headers.map((header, index) => [header, coerceValue(values[index] ?? "")])));
};

const timeAliases = ["atseconds", "seconds", "timestamp", "time", "videotime"];

const firstTime = (value: unknown): number | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (!timeAliases.includes(normalizeKey(key))) continue;
    const numeric = typeof child === "number" ? child : Number(child);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  }
  return undefined;
};

export const createDemoAnalysis = (videoName: string, dataName: string, data: unknown): Analysis => {
  const analysis = structuredClone(demoAnalysis);
  analysis.provenance = { videoFile: videoName, dataFile: dataName };
  const xfg = findMetric(data, ["xfg", "xfgpct", "expectedfg", "expectedfieldgoalpercentage"]);
  const gravity = findMetric(data, ["gravity", "onballgravity", "gravityscore"]);
  const impact = findMetric(data, ["winimpact", "impact", "winprobabilityadded"]);
  if (xfg !== undefined) {
    analysis.events[1]!.metric.value = xfg > 1 ? xfg / 100 : xfg;
    analysis.events[1]!.metric.source = `输入资料：${dataName} · xFG`;
    analysis.events[1]!.evidence = [`输入资料 ${dataName} 提供 xFG 数值`, "当前事件没有推断逐帧球员轨迹"];
  }
  if (gravity !== undefined) {
    analysis.events[0]!.metric.value = gravity;
    analysis.events[0]!.metric.source = `输入资料：${dataName} · gravity`;
    analysis.events[0]!.evidence = [`输入资料 ${dataName} 提供引力指标`, "当前事件没有推断逐帧球员轨迹"];
  }
  if (impact !== undefined) {
    analysis.events[2]!.metric.value = impact;
    analysis.events[2]!.metric.source = `输入资料：${dataName} · winImpact`;
    analysis.events[2]!.evidence = [`输入资料 ${dataName} 提供胜负影响指标`, "解释限定在当前视频片段"];
  }
  const availableKinds = new Set([
    ...(xfg === undefined ? [] : ["expected_field_goal_percentage"]),
    ...(gravity === undefined ? [] : ["on_ball_gravity"]),
    ...(impact === undefined ? [] : ["win_impact"])
  ]);
  analysis.events = analysis.events.filter((event) => availableKinds.has(event.metric.kind));
  const availableEventIds = new Set(analysis.events.map((event) => event.id));
  analysis.narration = analysis.narration.filter((cue) => (
    (cue.id === "n1" && availableEventIds.has("gravity-read"))
    || (cue.id === "n2" && availableEventIds.has("shot-quality"))
    || (cue.id === "n3" && availableEventIds.has("win-impact"))
  ));
  const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
  const firstTimestamp = rows.map(firstTime).find((value): value is number => value !== undefined);
  if (firstTimestamp !== undefined) {
    analysis.events = analysis.events.map((event, index) => ({
      ...event,
      startSeconds: Math.max(0, firstTimestamp + index * 0.5),
      endSeconds: Math.max(0.6, firstTimestamp + index * 0.5 + 1.4)
    }));
  }
  if (availableKinds.size === 0) {
    analysis.summary = "未提供可计算的结构化指标，仅保留有来源的视觉或人工证据。";
    analysis.events = [];
    analysis.narration = [];
    analysis.warnings = ["输入资料没有识别到 xFG、引力或胜负影响；本地模式不会用演示指标填充结果。"];
  } else {
    analysis.summary = `本地规则读取了 ${availableKinds.size} 项有来源指标；未提供的指标保持为空。`;
  }
  return analysisSchema.parse(analysis);
};

export const parseDataFile = async (file?: File): Promise<unknown> => {
  if (!file) return {};
  const content = await file.text();
  if (file.name.toLowerCase().endsWith(".json")) return JSON.parse(content.replace(/^\uFEFF/, ""));
  return parseCsv(content);
};

export const parseStatsTimeline = (value: unknown): GameStatsTimeline | undefined => {
  const candidates = [
    value,
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).stats : undefined,
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).gameStatsTimeline : undefined
  ];
  for (const candidate of candidates) {
    const parsed = gameStatsTimelineSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return undefined;
};
