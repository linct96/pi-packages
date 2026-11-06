import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createFooterStatus, formatResponseStats, TIMING_ENTRY } from "./footer.ts";

export default function footerStatus(pi: ExtensionAPI) {
  let run:
    | {
        startedAt: number;
        entryOffset: number;
        ttftMs?: number;
        requestMs: number;
        outputTokens: number;
        messageEntryId?: string;
      }
    | undefined;
  let startedAt: number | undefined;
  let firstOutputAt: number | undefined;
  let pending: { ttftMs: number; generationMs: number } | undefined;
  let requestRender: (() => void) | undefined;
  const reset = () => {
    startedAt = undefined;
    firstOutputAt = undefined;
    pending = undefined;
  };
  const resetRun = () => {
    reset();
    run = undefined;
  };

  pi.registerEntryRenderer<{ stats?: string }>(TIMING_ENTRY, (entry, _options, theme) => {
    const stats =
      typeof entry.data?.stats === "string" ? entry.data.stats.replace(/[\r\n\t]/g, " ") : "";
    if (!stats) return;
    return {
      invalidate() {},
      render: (width) =>
        width > 0 ? [truncateToWidth(theme.fg("dim", stats), width, theme.fg("dim", "..."))] : [],
    };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    run ??= {
      startedAt: performance.now(),
      entryOffset: ctx.sessionManager.getEntries().length,
      requestMs: 0,
      outputTokens: 0,
    };
  });
  pi.on("before_provider_request", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    reset();
    if (run) run.messageEntryId = undefined;
    startedAt = performance.now();
  });
  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui" || startedAt === undefined || firstOutputAt !== undefined) return;
    const update = event.assistantMessageEvent;
    if (
      (update.type === "text_delta" ||
        update.type === "thinking_delta" ||
        update.type === "toolcall_delta") &&
      update.delta.length > 0
    ) {
      firstOutputAt = performance.now();
    }
  });
  pi.on("message_end", (event, ctx) => {
    if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
    pending = undefined;
    if (
      startedAt !== undefined &&
      firstOutputAt !== undefined &&
      !["error", "aborted"].includes(event.message.stopReason)
    ) {
      pending = {
        ttftMs: firstOutputAt - startedAt,
        generationMs: performance.now() - firstOutputAt,
      };
    }
    startedAt = undefined;
    firstOutputAt = undefined;
  });
  pi.on("turn_end", (event, ctx) => {
    if (ctx.mode !== "tui" || !run || event.message.role !== "assistant") return;
    run.messageEntryId = undefined;
    if (!pending) return;
    run.ttftMs ??= pending.ttftMs;
    run.requestMs += pending.ttftMs + pending.generationMs;
    const output = event.message.usage.output;
    if (output > 0 && Number.isFinite(output)) run.outputTokens += output;
    if (!["toolUse", "error", "aborted"].includes(event.message.stopReason)) {
      run.messageEntryId = event.messageEntryId;
    }
    reset();
  });
  pi.on("agent_end", reset);
  pi.on("agent_settled", (event, ctx) => {
    const timing = run;
    resetRun();
    if (
      ctx.mode !== "tui" ||
      event.aborted ||
      !timing?.messageEntryId ||
      timing.ttftMs === undefined
    )
      return;
    // Only settle is final: agent_end may still be followed by retries or queued work.
    const data = {
      messageEntryId: timing.messageEntryId,
      ttftMs: timing.ttftMs,
      requestMs: timing.requestMs,
      outputTokens: timing.outputTokens,
      elapsedMs: performance.now() - timing.startedAt,
    };
    const stats = formatResponseStats(
      ctx.sessionManager.getEntries().slice(timing.entryOffset),
      data,
    );
    if (!stats) return;
    pi.appendEntry(TIMING_ENTRY, { ...data, stats });
    requestRender?.();
  });
  pi.on("session_tree", resetRun);
  pi.on("session_shutdown", resetRun);
  pi.on("session_start", (_event, ctx) => {
    resetRun();
    if (ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      const footer = createFooterStatus(pi, ctx, theme, footerData);
      return {
        ...footer,
        dispose() {
          unsubscribe();
          requestRender = undefined;
        },
      };
    });
  });
}
