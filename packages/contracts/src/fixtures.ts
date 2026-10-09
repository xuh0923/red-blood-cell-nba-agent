import type { Analysis } from "./index.js";

export const demoAnalysis: Analysis = {
  version: "1.0",
  generatedBy: "local-rules",
  summary: "持球人吸引协防后仍完成高难度终结，回合价值来自空间牵制与出手质量之间的反差。",
  provenance: { videoFile: "training-possession.mp4", dataFile: "built-in-demo.json" },
  warnings: ["本地演示数据用于验证流程；正式结论必须替换为赛事数据和 AgentCore 分析。"],
  events: [
    {
      id: "gravity-read",
      startSeconds: 2.4,
      endSeconds: 6.8,
      title: "协防被持球引力带走",
      explanation: "两名防守者的注意力同时收缩，为弱侧创造了短暂空间。",
      player: "Primary ball handler",
      metric: {
        kind: "on_ball_gravity", value: 1.34, unit: "index", label: "持球引力",
        source: "赛事深度数据：当前回合"
      },
      anchor: "top-left",
      accent: "cyan",
      evidence: ["事件数据记录持球阶段", "画面关键帧显示第二防守人收缩"]
    },
    {
      id: "shot-quality",
      startSeconds: 8.1,
      endSeconds: 12.2,
      title: "高压下的出手选择",
      explanation: "出手位置和防守压力共同压低预期命中率，实际命中体现终结难度。",
      player: "Shooter",
      metric: {
        kind: "expected_field_goal_percentage", value: 0.418, unit: "percent", label: "预期命中率",
        source: "赛事深度数据：投篮事件"
      },
      anchor: "top-right",
      accent: "amber",
      evidence: ["投篮事件包含出手时刻与预期命中率", "不推断逐帧球员轨迹"]
    },
    {
      id: "win-impact",
      startSeconds: 13.2,
      endSeconds: 17.8,
      title: "这个回合改变了什么",
      explanation: "该回合带来正向胜负影响，但不把单次得分等同于整场贡献。",
      metric: {
        kind: "win_impact", value: 2.7, unit: "points", label: "胜负影响",
        source: "赛事深度数据：回合影响模型"
      },
      anchor: "bottom-left",
      accent: "green",
      evidence: ["回合影响值来自输入数据", "解释限定在当前片段"]
    }
  ],
  narration: [
    { id: "n1", startSeconds: 2.4, emotion: "focused", text: "注意协防正在向持球人收缩。" },
    { id: "n2", startSeconds: 8.1, emotion: "excited", text: "这是一记预期命中率只有百分之四十二的高难度出手。" },
    { id: "n3", startSeconds: 13.2, emotion: "happy", text: "这个回合为球队带来正向胜负影响。" }
  ]
};
