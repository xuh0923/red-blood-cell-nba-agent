import {
  analysisSchema, completedWorksResponseSchema, gameStatsTimelineSchema, trackingResultSchema,
  type Analysis, type GameStatsTimeline, type TrackingResult
} from "@courtvision/contracts";

export interface ShowcaseArtifact {
  id: string;
  teamId: "Team28";
  title: string;
  videoUrl: string;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  analysis: Analysis;
  tracking?: TrackingResult;
  stats?: GameStatsTimeline;
}

export const loadShowcaseWorks = async (): Promise<ShowcaseArtifact[]> => {
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname) || import.meta.env.VITE_API_URL) {
    try {
      const apiBase = ((import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "")) ?? "/api";
      const response = await fetch(`${apiBase}/works`, { cache: "no-store" });
      if (response.ok) {
        const cloud = completedWorksResponseSchema.parse(await response.json());
        if (cloud.works.length) return cloud.works;
      }
    } catch (error) {
      console.warn("AWS 作品库暂时不可用，回退到静态展示产物", error);
    }
  }
  const root = new URL("showcase/", window.location.href);
  const manifestResponse = await fetch(new URL("manifest.json", root), { cache: "no-store" });
  if (!manifestResponse.ok) throw new Error("本地展示产物不存在，请先运行 npm run showcase:prepare");
  const manifest = await manifestResponse.json() as {
    title?: string; videoUrl: string; analysisUrl: string; trackingUrl: string; statsUrl?: string;
  };
  const [analysisResponse, trackingResponse, statsResponse] = await Promise.all([
    fetch(new URL(manifest.analysisUrl, root), { cache: "no-store" }),
    fetch(new URL(manifest.trackingUrl, root), { cache: "no-store" }),
    manifest.statsUrl ? fetch(new URL(manifest.statsUrl, root), { cache: "no-store" }) : undefined
  ]);
  if (!analysisResponse.ok || !trackingResponse.ok) throw new Error("本地展示产物不完整，请重新生成展示文件");
  const analysis = analysisSchema.parse(await analysisResponse.json());
  const tracking = trackingResultSchema.parse(await trackingResponse.json());
  const stats = statsResponse?.ok ? gameStatsTimelineSchema.parse(await statsResponse.json()) : undefined;
  const now = new Date().toISOString();
  return [{
    id: "00000000-0000-4000-8000-000000000028",
    teamId: "Team28",
    title: manifest.title ?? "NBA 连续视觉分析展示",
    videoUrl: new URL(manifest.videoUrl, root).toString(),
    createdAt: now,
    updatedAt: now,
    durationSeconds: tracking.video.durationSeconds,
    analysis,
    tracking,
    stats
  }];
};
