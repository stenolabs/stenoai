import { readFileSync, existsSync, chmodSync } from "fs";
import path from "path";

export const MOCK_APPLE_SIDECAR_PATH = path.resolve(
  __dirname,
  "mock-apple-transcribe.js",
);

export interface SidecarLaunchLog {
  args: string[];
  time: number;
  pid: number;
}

export function ensureMockAppleSidecarExecutable(): string {
  try {
    chmodSync(MOCK_APPLE_SIDECAR_PATH, 0o755);
  } catch {
    // Best-effort chmod
  }
  return MOCK_APPLE_SIDECAR_PATH;
}

export function readSidecarLogs(logPath: string): SidecarLaunchLog[] {
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, "utf8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SidecarLaunchLog);
  } catch {
    return [];
  }
}
