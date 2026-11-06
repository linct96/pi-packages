import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseProbeConfig } from "./model-probe/config.ts";

export interface Settings {
  fast: boolean;
  modelProbe?: unknown;
  [key: string]: unknown;
}

async function readSettingsFile(
  path: string,
): Promise<{ text: string | undefined; settings: Settings }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { text: undefined, settings: { fast: false } };
    }
    throw error;
  }

  const settings: unknown = JSON.parse(text);
  if (
    !settings ||
    typeof settings !== "object" ||
    !("fast" in settings) ||
    typeof settings.fast !== "boolean"
  ) {
    throw new Error(`Invalid Codex settings in ${path}: fast must be a boolean`);
  }
  parseProbeConfig((settings as Settings).modelProbe);
  return { text, settings: { ...settings, fast: settings.fast } as Settings };
}

export async function readSettings(path: string): Promise<Settings> {
  return (await readSettingsFile(path)).settings;
}

export async function saveSettings(
  path: string,
  fast: boolean,
  expectedFast: boolean,
  signal: AbortSignal,
  probe?: { enabled: boolean; expectedSettings: Settings },
): Promise<Settings> {
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  signal.throwIfAborted();
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Codex settings are locked at ${lockPath}. Retry after the other writer finishes.`,
      );
    }
    throw error;
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    signal.throwIfAborted();
    const current = await readSettingsFile(path);
    if (current.settings.fast !== expectedFast) {
      throw new Error("Codex Fast changed on disk. Reopen /codex-settings before saving.");
    }
    if (probe && JSON.stringify(current.settings) !== JSON.stringify(probe.expectedSettings)) {
      throw new Error("Codex settings changed on disk. Reopen /codex-settings before saving.");
    }
    const updated: Settings = { ...current.settings, fast };
    if (probe) {
      const existing = current.settings.modelProbe;
      updated.modelProbe = {
        ...(existing && typeof existing === "object" ? existing : parseProbeConfig(undefined)),
        enabled: probe.enabled,
      };
    }
    await writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      signal,
    });
    const verified = await readSettingsFile(path);
    if (verified.text !== current.text) {
      throw new Error("Codex settings changed while saving. Reopen /codex-settings before saving.");
    }
    signal.throwIfAborted();
    // shortcut: external editors can race rename; require a shared writer protocol to eliminate that race.
    await rename(temporaryPath, path);
    return updated;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath);
      }
    }
  }
}
