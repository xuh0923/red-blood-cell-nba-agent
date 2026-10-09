import type { Analysis, OverlayEvent } from "@courtvision/contracts";

const colors = { cyan: "0x00D4FF", amber: "0xFFB020", red: "0xFF4D5E", green: "0x41D69C" } as const;

const escapeDrawText = (value: string): string => value
  .replace(/\\/g, "\\\\")
  .replace(/:/g, "\\:")
  .replace(/'/g, "\\'")
  .replace(/%/g, "\\%")
  .replace(/\n/g, " ");

const position = (event: OverlayEvent) => {
  const left = event.anchor.endsWith("left");
  const top = event.anchor.startsWith("top");
  return { x: left ? "48" : "w-text_w-48", y: top ? "56" : "h-text_h-72" };
};

export const buildFilterScript = (analysis: Analysis, fontFile = "/opt/fonts/NotoSansSC-Bold.otf"): string => {
  const filters = analysis.events.flatMap((event) => {
    const { x, y } = position(event);
    const enable = `between(t,${event.startSeconds.toFixed(3)},${event.endSeconds.toFixed(3)})`;
    const title = escapeDrawText(`${event.title}  ${event.metric.label}`);
    const detail = escapeDrawText(event.explanation);
    const base = `fontfile='${escapeDrawText(fontFile)}':x=${x}:y=${y}:enable='${enable}'`;
    return [
      `drawtext=text='${title}':${base}:fontsize=34:fontcolor=${colors[event.accent]}:box=1:boxcolor=0x081018CC:boxborderw=18`,
      `drawtext=text='${detail}':fontfile='${escapeDrawText(fontFile)}':x=${x}:y=${topOffset(y)}:enable='${enable}':fontsize=22:fontcolor=white:box=1:boxcolor=0x081018CC:boxborderw=14`
    ];
  });
  return `[0:v]${filters.join(",")}[vout]`;
};

const topOffset = (y: string): string => y.startsWith("h-") ? `${y}-46` : `${y}+62`;

export const buildFfmpegArgs = (input: string, filterScript: string, output: string): string[] => [
  "-y", "-i", input, "-filter_complex_script", filterScript,
  "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium",
  "-crf", "19", "-c:a", "aac", "-movflags", "+faststart", output
];
