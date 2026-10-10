import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const jobId = option("--job") ?? process.env.COURTVISION_SHOWCASE_JOB_ID;
const analysisArgument = option("--analysis") ?? process.env.COURTVISION_SHOWCASE_ANALYSIS;
const title = option("--title") ?? "NBA 连续视觉分析展示";
const teamId = option("--team-id") ?? "Team28";
const statsArgument = option("--stats") ?? process.env.COURTVISION_SHOWCASE_STATS ?? "docs/examples/showcase-stats.example.json";

if (!jobId || !analysisArgument) {
  throw new Error("用法: npm run showcase:prepare -- --job <本地任务ID> --analysis <分析JSON路径>");
}
if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("job 必须是 UUID 格式的本地任务 ID");

const jobDirectory = path.resolve(root, ".local-data", "jobs", jobId);
const job = JSON.parse(await readFile(path.join(jobDirectory, "job.json"), "utf8"));
if (job.status !== "completed" || typeof job.videoFileName !== "string") {
  throw new Error("指定任务未完成，或没有可发布的视频输入");
}
const analysisPath = path.resolve(root, analysisArgument);
const statsPath = path.resolve(root, statsArgument);
const outputDirectory = path.resolve(root, "apps", "web", "public", "showcase");
const safeOutputRoot = path.resolve(root, "apps", "web", "public");
if (!outputDirectory.startsWith(`${safeOutputRoot}${path.sep}`)) throw new Error("展示输出路径无效");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  copyFile(path.join(jobDirectory, "input", job.videoFileName), path.join(outputDirectory, "featured.mp4")),
  copyFile(path.join(jobDirectory, "tracking.json"), path.join(outputDirectory, "tracking.json")),
  copyFile(analysisPath, path.join(outputDirectory, "analysis.json")),
  copyFile(statsPath, path.join(outputDirectory, "stats.json"))
]);
await writeFile(path.join(outputDirectory, "manifest.json"), `${JSON.stringify({
  version: "1.0",
  teamId,
  title,
  videoUrl: "featured.mp4",
  analysisUrl: "analysis.json",
  trackingUrl: "tracking.json",
  statsUrl: "stats.json"
}, null, 2)}\n`, "utf8");
console.log(`已生成展示产物: ${path.relative(root, outputDirectory)}`);
