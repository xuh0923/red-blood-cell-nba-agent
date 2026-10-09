import { analysisSchema, trackingResultSchema, type Analysis, type TrackingResult } from "@courtvision/contracts";

export interface ShowcaseArtifact {
  version: "1.0";
  teamId: string;
  title: string;
  videoUrl: string;
  analysis: Analysis;
  tracking: TrackingResult;
}

interface ShowcaseManifest {
  version: "1.0";
  teamId: string;
  title: string;
  videoUrl: string;
  analysisUrl: string;
  trackingUrl: string;
}

const manifestUrl = new URL("showcase/manifest.json", window.location.href);

const readManifest = (value: unknown): ShowcaseManifest => {
  if (!value || typeof value !== "object") throw new Error("作品清单格式无效");
  const manifest = value as Partial<ShowcaseManifest>;
  if (
    manifest.version !== "1.0" || typeof manifest.teamId !== "string" || typeof manifest.title !== "string" ||
    typeof manifest.videoUrl !== "string" || typeof manifest.analysisUrl !== "string" || typeof manifest.trackingUrl !== "string"
  ) throw new Error("作品清单缺少必要字段");
  return manifest as ShowcaseManifest;
};

const getJson = async (url: URL): Promise<unknown> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`无法加载展示作品 (${response.status})`);
  return response.json();
};

export const loadShowcase = async (): Promise<ShowcaseArtifact> => {
  const manifest = readManifest(await getJson(manifestUrl));
  const [analysis, tracking] = await Promise.all([
    getJson(new URL(manifest.analysisUrl, manifestUrl)),
    getJson(new URL(manifest.trackingUrl, manifestUrl))
  ]);
  return {
    version: manifest.version,
    teamId: manifest.teamId,
    title: manifest.title,
    videoUrl: new URL(manifest.videoUrl, manifestUrl).toString(),
    analysis: analysisSchema.parse(analysis),
    tracking: trackingResultSchema.parse(tracking)
  };
};
