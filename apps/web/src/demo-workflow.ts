import type { Analysis, JobStatus } from "@courtvision/contracts";
import { analysisSchema } from "@courtvision/contracts";
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

export const createDemoAnalysis = (videoName: string, dataName: string, data: unknown): Analysis => {
  const analysis = structuredClone(demoAnalysis);
  analysis.provenance = { videoFile: videoName, dataFile: dataName };
  const xfg = findMetric(data, ["xfg", "xfgpct", "expectedfg", "expectedfieldgoalpercentage"]);
  const gravity = findMetric(data, ["gravity", "onballgravity", "gravityscore"]);
  const impact = findMetric(data, ["winimpact", "impact", "winprobabilityadded"]);
  if (xfg !== undefined) analysis.events[1]!.metric.value = xfg > 1 ? xfg / 100 : xfg;
  if (gravity !== undefined) analysis.events[0]!.metric.value = gravity;
  if (impact !== undefined) analysis.events[2]!.metric.value = impact;
  return analysisSchema.parse(analysis);
};

export const parseDataFile = async (file?: File): Promise<unknown> => {
  if (!file) return {};
  const content = await file.text();
  if (file.name.toLowerCase().endsWith(".json")) return JSON.parse(content);
  const [headerLine = "", ...rows] = content.trim().split(/\r?\n/);
  const headers = headerLine.split(",").map((value) => value.trim());
  return rows.map((row) => Object.fromEntries(row.split(",").map((value, index) => [headers[index] ?? `field_${index}`, value.trim()])));
};
