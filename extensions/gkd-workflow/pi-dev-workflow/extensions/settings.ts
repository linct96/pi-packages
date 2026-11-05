import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export type WorkflowSettings = { version: 1; autoStart: boolean };
export const DEFAULT_SETTINGS: WorkflowSettings = { version: 1, autoStart: false };

/** User-level extension settings, separate from Pi's built-in settings.json. */
export function settingsPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "dev-workflow", "settings.json");
}

export async function readSettings(): Promise<WorkflowSettings> {
  try {
    const data: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    if (!data || typeof data !== "object" || (data as any).version !== 1) return { ...DEFAULT_SETTINGS };
    return { version: 1, autoStart: (data as any).autoStart === true };
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return { ...DEFAULT_SETTINGS };
    throw error;
  }
}

export async function writeSettings(settings: WorkflowSettings): Promise<void> {
  const target = settingsPath();
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}
