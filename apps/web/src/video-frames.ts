export interface ExtractedFrame {
  blob: Blob;
  previewUrl: string;
  atSeconds: number;
  width: number;
  height: number;
}

export const sampleTimestamps = (duration: number, count = 6): number[] => {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长");
  if (count < 3 || count > 8) throw new Error("关键帧数量必须在 3 到 8 之间");
  const margin = Math.min(0.5, duration * 0.05);
  const usable = Math.max(0.1, duration - margin * 2);
  return Array.from({ length: count }, (_, index) => Number((margin + usable * ((index + 0.5) / count)).toFixed(3)));
};

const waitFor = (target: HTMLMediaElement, event: "loadedmetadata" | "seeked"): Promise<void> => new Promise((resolve, reject) => {
  const cleanup = () => {
    target.removeEventListener(event, onReady);
    target.removeEventListener("error", onError);
  };
  const onReady = () => { cleanup(); resolve(); };
  const onError = () => { cleanup(); reject(new Error("浏览器无法解码该视频")); };
  target.addEventListener(event, onReady, { once: true });
  target.addEventListener("error", onError, { once: true });
});

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("关键帧编码失败")), "image/jpeg", 0.82);
});

export const extractVideoFrames = async (file: File, count = 6): Promise<{ duration: number; frames: ExtractedFrame[] }> => {
  const sourceUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = sourceUrl;

  try {
    await waitFor(video, "loadedmetadata");
    const duration = video.duration;
    const timestamps = sampleTimestamps(duration, count);
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持画面抽取");

    const frames: ExtractedFrame[] = [];
    for (const atSeconds of timestamps) {
      video.currentTime = atSeconds;
      await waitFor(video, "seeked");
      context.drawImage(video, 0, 0, width, height);
      const blob = await canvasBlob(canvas);
      frames.push({ blob, previewUrl: URL.createObjectURL(blob), atSeconds, width, height });
    }
    return { duration, frames };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(sourceUrl);
  }
};

export const releaseFrames = (frames: ExtractedFrame[]) => frames.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
