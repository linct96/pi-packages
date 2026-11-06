import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function singleLine(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export const TIMING_ENTRY = "footer-status:timing";

function readTiming(data: unknown) {
  if (
    typeof data !== "object" ||
    data === null ||
    !("messageEntryId" in data) ||
    typeof data.messageEntryId !== "string" ||
    !("ttftMs" in data) ||
    typeof data.ttftMs !== "number" ||
    !Number.isFinite(data.ttftMs) ||
    data.ttftMs < 0 ||
    !("requestMs" in data) ||
    typeof data.requestMs !== "number" ||
    !Number.isFinite(data.requestMs) ||
    data.requestMs < 0 ||
    !("outputTokens" in data) ||
    typeof data.outputTokens !== "number" ||
    !Number.isFinite(data.outputTokens) ||
    data.outputTokens < 0
  )
    return;
  const elapsedMs =
    "elapsedMs" in data &&
    typeof data.elapsedMs === "number" &&
    Number.isFinite(data.elapsedMs) &&
    data.elapsedMs >= 0
      ? data.elapsedMs
      : undefined;
  return {
    messageEntryId: data.messageEntryId,
    ttftMs: data.ttftMs,
    requestMs: data.requestMs,
    outputTokens: data.outputTokens,
    elapsedMs,
  };
}

function summarizeUsage(entries: readonly SessionEntry[]) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  for (const entry of entries) {
    let usage;
    if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
    } else if (entry.type === "message" && entry.message.role === "toolResult") {
      usage = entry.message.usage;
    } else if (
      entry.type === "usage" ||
      entry.type === "compaction" ||
      entry.type === "branch_summary"
    ) {
      usage = entry.usage;
    }
    if (!usage) continue;
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.totalTokens += usage.totalTokens;
    totals.cost += usage.cost.total;
  }
  return totals;
}

export function formatResponseStats(entries: readonly SessionEntry[], data: unknown): string {
  const timing = readTiming(data);
  if (!timing) return "";
  const entry = entries.find((entry) => entry.id === timing.messageEntryId);
  if (entry?.type !== "message" || entry.message.role !== "assistant") return "";
  if (["error", "aborted", "toolUse"].includes(entry.message.stopReason)) return "";
  const totals = summarizeUsage(entries);
  const stats: string[] = [];
  if (timing.outputTokens > 0) {
    const tps = timing.requestMs > 0 ? timing.outputTokens / (timing.requestMs / 1000) : undefined;
    if (tps !== undefined && Number.isFinite(tps)) stats.push(`TPS ${tps.toFixed(1)}`);
    stats.push(`TTFT ${(timing.ttftMs / 1000).toFixed(2)}s`);
  }
  for (const [key, label] of [
    ["input", "in"],
    ["output", "out"],
    ["cacheRead", "cr"],
    ["cacheWrite", "cw"],
    ["totalTokens", "total"],
  ] as const) {
    if (totals[key]) stats.push(`${label} ${formatTokens(totals[key])}`);
  }
  const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
  if ((totals.cacheRead || totals.cacheWrite) && promptTokens > 0) {
    stats.push(`CH ${((totals.cacheRead / promptTokens) * 100).toFixed(1)}%`);
  }
  if (timing.elapsedMs !== undefined) stats.push(`time ${(timing.elapsedMs / 1000).toFixed(1)}s`);
  return stats.join(", ");
}

export function createFooterStatus(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
) {
  let cachedLeaf: string | null | undefined;
  let totals: ReturnType<typeof summarizeUsage>;
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [""];
      const leaf = ctx.sessionManager.getLeafId();
      if (!totals || leaf !== cachedLeaf) {
        // Match Pi's cumulative billing: include all branches and pre-compaction usage.
        totals = summarizeUsage(ctx.sessionManager.getEntries());
        cachedLeaf = leaf;
      }
      let cwd = ctx.sessionManager.getCwd();
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        const path = relative(resolve(home), resolve(cwd));
        if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
          cwd = path ? `~${sep}${path}` : "~";
        }
      }
      const branch = footerData.getGitBranch();
      const name = ctx.sessionManager.getSessionName();
      const path = singleLine(cwd);
      const location = path + (branch ? ` (${singleLine(branch)})` : "");
      const model = ctx.model;
      const thinking = pi.getThinkingLevel();
      const modelId = model ? singleLine(model.id) : "no-model";
      const thinkingInfo = model?.reasoning
        ? ` • ${singleLine(thinking === "off" ? "thinking off" : thinking)}`
        : "";
      const modelInfo = modelId + thinkingInfo;
      const provider = model
        ? singleLine(
            model.provider === "openai-codex"
              ? "sub"
              : model.provider === "openai"
                ? "api"
                : model.provider,
          )
        : "";
      const modelWithProvider = modelId + (provider ? ` (${provider})` : "") + thinkingInfo;
      const subscription =
        model && (model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model));
      const cost = totals.cost || subscription ? `$${totals.cost.toFixed(3)}` : "";
      const usage = ctx.getContextUsage();
      const percent = usage?.percent;
      const contextPercent = percent === null ? "?" : `${(percent ?? 0).toFixed(1)}%`;
      const contextWindow = formatTokens(usage?.contextWindow ?? model?.contextWindow ?? 0);
      const context = `${contextPercent}/${contextWindow}`;
      const contextColor = (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "dim";
      const contextInfo = theme.fg(contextColor, context);
      const rightLayouts = [
        [cost, contextInfo, modelWithProvider],
        [cost, contextInfo, modelInfo],
        [contextInfo, modelInfo],
        [modelInfo],
        [modelId],
      ].map((fields) =>
        fields
          .filter(Boolean)
          .map((field) => theme.fg("dim", field))
          .join(theme.fg("dim", " | ")),
      );
      // Preserve path and branch before right-side fields; drop the session name first.
      const layouts = [
        [location + (name ? ` • ${singleLine(name)}` : ""), rightLayouts[0]],
        ...rightLayouts.map((right) => [location, right]),
        [location, ""],
        [path, ""],
      ];
      let firstLine = truncateToWidth(path, width, "...");
      for (const [left, right] of layouts) {
        const padding = width - visibleWidth(left) - visibleWidth(right);
        if (padding < (right ? 2 : 0)) continue;
        firstLine = right ? left + " ".repeat(padding) + right : left;
        break;
      }

      const lines = [theme.fg("dim", firstLine)];
      const statuses = [...footerData.getExtensionStatuses()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => singleLine(text));
      if (statuses.length)
        lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "...")));
      return lines;
    },
  };
}
