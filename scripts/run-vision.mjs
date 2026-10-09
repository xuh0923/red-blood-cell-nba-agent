import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const candidates = process.platform === "win32"
  ? [path.join(root, ".venv", "Scripts", "python.exe"), "python"]
  : [path.join(root, ".venv", "bin", "python"), "python3"];
const executable = candidates.find((candidate) => candidate === "python" || candidate === "python3" || existsSync(candidate));

const child = spawn(executable, [
  "-m", "uvicorn", "main:app",
  "--app-dir", "services/vision",
  "--host", "127.0.0.1",
  "--port", "8787"
], { cwd: root, stdio: "inherit" });

child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
