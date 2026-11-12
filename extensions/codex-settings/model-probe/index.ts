import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ImageContent } from "@earendil-works/pi-ai";
import { readSettings } from "../settings.ts";
import { parseProbeConfig, type ProbeConfig } from "./config.ts";
import { validateAnswer } from "./validator.ts";
import { FAILURE_OPTIONS, selectFailureAction } from "./failure-dialog.ts";

export const PROBE_ENTRY = "codex-settings:model-probe";
export const HANDOFF_ENTRY = "codex-settings:model-probe-handoff";

// Commands are intercepted before they add conversation entries. A registered
// gate belongs to the active Pi session; absent Model Probe is not a blocker.
type WorkloopGate = (request: string, ctx: ExtensionContext) => boolean;
const globalProbeRegistry = globalThis as typeof globalThis & {
  __linct96WorkloopProbeGates?: Map<string, WorkloopGate>;
};
const workloopGates = (globalProbeRegistry.__linct96WorkloopProbeGates ??= new Map<
  string,
  WorkloopGate
>());
export function deferWorkloopForProbe(request: string, ctx: ExtensionContext): boolean {
  return workloopGates.get(ctx.sessionManager.getSessionId())?.(request, ctx) ?? false;
}
const QUESTION = "codex-settings:model-probe";
const RESTART = "codex-probe-restart";
type Phase = "PENDING" | "TESTING" | "PASSED" | "FAILED" | "RESTARTING" | "DELIVERING" | "READY";
interface PendingMessage {
  id: string;
  text: string;
  images: ImageContent[];
  delivery: "pending" | "delivering" | "delivered" | "transferred";
}
interface ProbeHandoff {
  pendingMessage?: PendingMessage;
  attempt?: number;
  selection?: {
    provider: string;
    id: string;
    api: string;
    thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
  };
}
interface ProbeState {
  version: 1;
  sessionId: string;
  runId: string;
  phase: Phase;
  config: ProbeConfig;
  model: string;
  index: number;
  attempt?: number;
  results: ReturnType<typeof validateAnswer>[];
  pendingMessage?: PendingMessage;
  reason?: string;
  logs?: string[];
}

function validPending(value: unknown): value is PendingMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as PendingMessage;
  return (
    typeof message.id === "string" &&
    !!message.id &&
    typeof message.text === "string" &&
    Array.isArray(message.images) &&
    message.images.every(
      (image) =>
        image?.type === "image" &&
        typeof image.data === "string" &&
        !!image.data &&
        typeof image.mimeType === "string" &&
        !!image.mimeType,
    ) &&
    ["pending", "delivering", "delivered", "transferred"].includes(message.delivery)
  );
}

const validAttempt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const modelKey = (ctx: ExtensionContext) =>
  JSON.stringify([ctx.model?.provider, ctx.model?.id, ctx.model?.api, ctx.thinkingLevel]);
const hasConversation = (ctx: ExtensionContext) =>
  ctx.sessionManager
    .getBranch()
    .some((e) =>
      e.type === "message"
        ? e.message.role !== "system"
        : ["custom_message", "compaction", "branch_summary"].includes(e.type),
    );

export function createModelProbe(pi: ExtensionAPI, settingsPath: string) {
  let state: ProbeState | undefined;
  let pendingConfig: ProbeConfig | undefined;
  let models = parseProbeConfig(undefined).models;
  const applies = (ctx: ExtensionContext) => !!ctx.model && models.includes(ctx.model.id);
  let enabled = false;
  let loading = true;
  let fault = false;
  let generation = 0;
  let liveSession = "";
  let active:
    | { runId: string; index: number; started: boolean; answer?: string; error?: string }
    | undefined;
  let deliveryAccepted = false;
  let restartToken: { token: string; attempt: number } | undefined;
  let restoringSelection = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmation: AbortController | undefined;
  let promptOptions: { forceSystemPrompt?: string } | undefined;
  let panelCreated = false;

  pi.registerMessageRenderer<{ runId: string }>(QUESTION, (message, { outputPad }, theme) => {
    const runId = message.details?.runId;
    if (runId === state?.runId) panelCreated = true;
    const body = new Text("", 0, 0);
    const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(body);
    return {
      render(width) {
        const report = state?.runId === runId ? state : undefined;
        const status = !report
          ? "检测状态未知"
          : report.reason === "user_override"
            ? "检测失败（已选择继续）"
            : {
                PENDING: "检测中...",
                TESTING: "检测中...",
                PASSED: "检测通过",
                FAILED: "检测失败",
                RESTARTING: "正在重新创建会话...",
                DELIVERING: "检测通过",
                READY: "检测通过",
              }[report.phase];
        const lines = [`[${QUESTION}]`];
        if (report) {
          for (const [index, question] of report.config.questions.entries()) {
            if (index > report.index) break;
            const result = report.results.find((item) => item.questionId === question.id);
            lines.push("", `问题：${question.question}`, `答案：${question.answer}`);
            if (result?.actual) lines.push(`回答：${result.actual}`);
          }
        }
        if (report?.reason) lines.push("", `原因：${report.reason}`);
        lines.push(
          "",
          report && report.config.maxAttempts > 1
            ? `第 ${report.attempt ?? 1}/${report.config.maxAttempts} 轮${status}`
            : status,
        );
        body.setText(theme.fg("customMessageText", stripVTControlCharacters(lines.join("\n"))));
        return box.render(width);
      },
      invalidate() {
        box.invalidate();
      },
    };
  });

  function updateStatus(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    // shortcut: like Fast, stored ANSI colors refresh on reload after a theme change.
    ctx.ui.setStatus(QUESTION, enabled ? ctx.ui.theme.fg("dim", "| Model Probe |") : undefined);
  }

  function notify(ctx: ExtensionContext, text: string, error = false) {
    if (ctx.mode === "tui" && state && !fault && current(ctx)) {
      try {
        persist(ctx, { logs: [...(state.logs ?? []), `${error ? "错误" : "状态"}：${text}`] });
      } catch {
        return;
      } // Persistence failure already reports outside the panel and closes the gate.
      if (panelCreated || state.phase === "PENDING") return;
    }
    if (ctx.hasUI) ctx.ui.notify(`Model Probe: ${text}`, error ? "error" : "info");
    else console.error(`Model Probe: ${text}`);
  }
  function blocked(ctx: ExtensionContext) {
    return (
      applies(ctx) && (loading || fault || (!!state && !["PASSED", "READY"].includes(state.phase)))
    );
  }
  function current(ctx: ExtensionContext, version = generation) {
    return version === generation && ctx.sessionManager.getSessionId() === liveSession;
  }
  function persist(ctx: ExtensionContext, patch: Partial<ProbeState>) {
    if (!state || !current(ctx)) throw new Error("Model Probe session expired");
    state = { ...state, ...patch };
    try {
      pi.appendEntry(PROBE_ENTRY, state);
    } catch (error) {
      fault = true;
      notify(ctx, `无法保存检测状态，已阻止任务执行：${errorText(error)}`, true);
      throw error;
    }
  }
  function stop() {
    clearTimeout(startupTimer);
    startupTimer = undefined;
    active = undefined;
    promptOptions = undefined;
    deliveryAccepted = false;
    restartToken = undefined;
    confirmation?.abort();
    confirmation = undefined;
  }
  function requestRestart(ctx: ExtensionContext, attempt = 1) {
    if (!state || state.phase !== "FAILED" || fault || !current(ctx) || restartToken) return;
    restartToken = { token: randomUUID(), attempt };
    try {
      pi.sendUserMessage(`/${RESTART} ${restartToken.token}`, { expandPromptTemplates: true });
    } catch (error) {
      fail(ctx, `restart_dispatch_failed: ${errorText(error)}`, false);
    }
  }
  async function offerFailureAction(ctx: ExtensionContext) {
    if (
      !state ||
      state.phase !== "FAILED" ||
      fault ||
      !ctx.hasUI ||
      !["tui", "rpc"].includes(ctx.mode) ||
      confirmation
    )
      return;
    const version = generation;
    const controller = new AbortController();
    confirmation = controller;
    try {
      const options = FAILURE_OPTIONS;
      const choice = await selectFailureAction(ctx, controller.signal);
      if (controller.signal.aborted || !current(ctx, version) || state?.phase !== "FAILED" || fault)
        return;
      if (choice === options[0]) {
        requestRestart(ctx);
      } else if (choice === options[1]) {
        persist(ctx, { reason: "user_override" });
        notify(ctx, "已选择继续当前会话，跳过本次检测失败并发送原消息。");
        deliver(ctx);
      }
    } catch (error) {
      if (current(ctx, version) && !controller.signal.aborted)
        notify(ctx, `无法处理失败选项：${errorText(error)}`, true);
    } finally {
      if (confirmation === controller) confirmation = undefined;
    }
  }
  function fail(ctx: ExtensionContext, reason: string, ask = true) {
    stop();
    persist(ctx, { phase: "FAILED", reason });
    notify(ctx, `检测失败 (${reason})；正常任务已阻止。`, true);
    if (ask) return offerFailureAction(ctx);
  }
  function deliver(ctx: ExtensionContext) {
    if (fault) return;
    const pending = state?.pendingMessage;
    if (!pending || pending.delivery !== "pending") {
      persist(ctx, { phase: "READY" });
      return;
    }
    // Persist before dispatch: an uncertain crash must never replay a side-effecting task.
    persist(ctx, { phase: "DELIVERING", pendingMessage: { ...pending, delivery: "delivering" } });
    armStartup(ctx, "pending_message_dispatch_failed");
    try {
      pi.sendUserMessage([{ type: "text", text: pending.text }, ...pending.images]);
    } catch (error) {
      fail(ctx, `pending_message_dispatch_failed: ${errorText(error)}`, false);
    }
  }
  function armStartup(ctx: ExtensionContext, reason: string) {
    clearTimeout(startupTimer);
    const version = generation;
    // shortcut: fire-and-forget Pi dispatch has no rejection callback; report a missing start after 10s.
    startupTimer = setTimeout(() => {
      if (current(ctx, version) && blocked(ctx)) {
        ctx.abort();
        fail(ctx, reason, false);
      }
    }, 10000);
    startupTimer.unref();
  }
  function askQuestion(ctx: ExtensionContext) {
    if (!state || fault || !current(ctx)) return;
    if (!ctx.model || modelKey(ctx) !== state.model) {
      fail(ctx, "model_changed_or_missing");
      return;
    }
    const q = state.config.questions[state.index];
    persist(ctx, { phase: "TESTING" });
    active = { runId: state.runId, index: state.index, started: false };
    armStartup(ctx, "probe_dispatch_failed");
    try {
      pi.sendMessage(
        {
          customType: QUESTION,
          content: q.question,
          display: ctx.mode !== "tui" || state.index === 0,
          details: { runId: state.runId, index: state.index },
        },
        { triggerTurn: true },
      );
    } catch (error) {
      fail(ctx, `probe_dispatch_failed: ${errorText(error)}`);
    }
  }

  function gateWorkloopCommand(request: string, ctx: ExtensionContext): boolean {
    if (!enabled || !applies(ctx)) return false;
    if (loading || fault) {
      notify(ctx, "Model Probe 尚未就绪，Workloop 请求未执行。", true);
      return true;
    }
    if (state && ["PASSED", "READY"].includes(state.phase)) return false;
    // A message delivered by Model Probe is already authorized to continue.
    if (state?.phase === "DELIVERING" && state.pendingMessage?.text === request) return false;
    if (!state && pendingConfig && !hasConversation(ctx)) {
      state = {
        version: 1,
        sessionId: liveSession,
        runId: randomUUID(),
        phase: "PENDING",
        config: { ...pendingConfig, enabled },
        model: modelKey(ctx),
        index: 0,
        results: [],
      };
      pendingConfig = undefined;
    }
    if (!state) return false; // Existing conversations are not retroactively probed.
    if (!state.pendingMessage) {
      persist(ctx, {
        pendingMessage: {
          id: randomUUID(),
          text: request,
          images: [],
          delivery: "pending",
        },
      });
      notify(ctx, "Workloop 请求已暂存，模型检测通过前不会执行。");
    } else {
      notify(ctx, "已有待处理请求，Workloop 暂不接受重复投递。");
    }
    if (state.phase === "PENDING") askQuestion(ctx);
    return true;
  }

  async function restore(ctx: ExtensionContext, tree = false) {
    const version = ++generation;
    stop();
    state = undefined;
    panelCreated = false;
    pendingConfig = undefined;
    fault = false;
    loading = true;
    liveSession = ctx.sessionManager.getSessionId();
    let config: ProbeConfig;
    try {
      config = parseProbeConfig((await readSettings(settingsPath)).modelProbe);
      if (!current(ctx, version)) return;
      enabled = config.enabled;
      models = config.models;
    } catch (error) {
      if (!current(ctx, version)) return;
      loading = false;
      fault = true;
      enabled = false;
      updateStatus(ctx);
      notify(ctx, `配置无效，未执行检测或正常任务：${errorText(error)}`, true);
      return;
    }
    const branch = ctx.sessionManager.getBranch();
    const stored = [...branch]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === PROBE_ENTRY);
    const handoff = [...branch]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === HANDOFF_ENTRY);
    const setting = [...branch]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === `${PROBE_ENTRY}:setting`);
    if (
      setting?.type === "custom" &&
      typeof (setting.data as { enabled?: unknown })?.enabled === "boolean"
    )
      enabled = (setting.data as { enabled: boolean }).enabled;
    config = { ...config, enabled };
    updateStatus(ctx);
    const conversation = hasConversation(ctx);
    if (!stored && handoff?.type === "custom") {
      try {
        const selection = (handoff.data as ProbeHandoff)?.selection;
        if (selection !== undefined) {
          if (
            !selection ||
            ![selection.provider, selection.id, selection.api].every(
              (value) => typeof value === "string" && !!value,
            ) ||
            !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
              selection.thinkingLevel,
            )
          )
            throw new Error("Invalid handoff selection");
          restoringSelection = true;
          if (
            ctx.model?.provider !== selection.provider ||
            ctx.model.id !== selection.id ||
            ctx.model.api !== selection.api
          ) {
            const model = ctx.modelRegistry.find(selection.provider, selection.id);
            if (!model || model.api !== selection.api || !(await pi.setModel(model)))
              throw new Error("Handoff model unavailable");
          }
          if (!current(ctx, version)) return;
          pi.setThinkingLevel(selection.thinkingLevel);
          if (
            ctx.model?.provider !== selection.provider ||
            ctx.model.id !== selection.id ||
            ctx.model.api !== selection.api ||
            (ctx.thinkingLevel ?? pi.getThinkingLevel()) !== selection.thinkingLevel
          )
            throw new Error("Handoff model or thinking level unavailable");
        }
      } catch (error) {
        if (!current(ctx, version)) return;
        loading = false;
        fault = true;
        notify(ctx, `无法继承模型或思考级别，未执行检测或原任务：${errorText(error)}`, true);
        return;
      } finally {
        restoringSelection = false;
      }
    }
    loading = false;
    // Out-of-scope models neither resume probes nor replay their pending tasks.
    if (!applies(ctx)) return;
    if (stored?.type === "custom") {
      try {
        const saved = stored.data as ProbeState;
        if (
          saved?.version !== 1 ||
          !["PENDING", "TESTING", "PASSED", "FAILED", "RESTARTING", "DELIVERING", "READY"].includes(
            saved.phase,
          ) ||
          typeof saved.sessionId !== "string" ||
          typeof saved.runId !== "string" ||
          typeof saved.model !== "string" ||
          !Array.isArray(saved.results) ||
          saved.results.some(
            (r) =>
              !r ||
              typeof r.questionId !== "string" ||
              typeof r.actual !== "string" ||
              typeof r.passed !== "boolean",
          ) ||
          !Number.isInteger(saved.index) ||
          saved.index < 0 ||
          saved.index >= parseProbeConfig(saved.config).questions.length
        )
          throw new Error("Invalid saved probe state");
        if (saved.attempt !== undefined && !validAttempt(saved.attempt))
          throw new Error("Invalid saved probe attempt");
        if (saved.pendingMessage !== undefined && !validPending(saved.pendingMessage))
          throw new Error("Invalid pending message");
        if (
          saved.logs !== undefined &&
          (!Array.isArray(saved.logs) || saved.logs.some((line) => typeof line !== "string"))
        )
          throw new Error("Invalid saved probe logs");
        state = { ...saved, config: parseProbeConfig(saved.config) };
        const pending = saved.pendingMessage;
        const attemptedElsewhere =
          pending?.delivery === "pending" &&
          ctx.sessionManager.getEntries().some((entry) => {
            if (entry.type !== "custom" || entry.customType !== PROBE_ENTRY) return false;
            const message = (entry.data as ProbeState)?.pendingMessage;
            return message?.id === pending.id && message.delivery !== "pending";
          });
        if (attemptedElsewhere) {
          persist(ctx, { pendingMessage: { ...pending!, delivery: "delivering" } });
          fail(ctx, "delivery_attempted_on_another_branch", false);
        } else if (saved.sessionId !== liveSession) {
          state = { ...saved, sessionId: liveSession };
          fail(ctx, "fork_requires_clean_new_session", false);
        } else if (saved.model !== modelKey(ctx)) fail(ctx, "model_changed", false);
        else if (["PENDING", "TESTING", "RESTARTING"].includes(saved.phase))
          fail(ctx, "probe_interrupted", false);
        else if (saved.phase === "DELIVERING" || saved.pendingMessage?.delivery === "delivering")
          fail(ctx, "delivery_uncertain_not_replayed", false);
        else if (saved.phase === "PASSED") deliver(ctx);
      } catch (error) {
        fault = true;
        notify(ctx, `无法恢复检测状态，任务已阻止：${errorText(error)}`, true);
      }
      return;
    }
    const previouslyProbed = ctx.sessionManager
      .getEntries()
      .some((e) => e.type === "custom" && e.customType === PROBE_ENTRY);
    // A clean session waits for its first user input; old conversations are never retroactively tested.
    if (!handoff && !previouslyProbed) {
      if (!conversation) pendingConfig = config;
      return;
    }
    state = {
      version: 1,
      sessionId: liveSession,
      runId: randomUUID(),
      phase: "PENDING",
      config,
      model: modelKey(ctx),
      index: 0,
      results: [],
    };
    try {
      if (handoff?.type === "custom") {
        const data = handoff.data as ProbeHandoff;
        if (!data || typeof data !== "object") throw new Error("Invalid handoff");
        if (data.attempt !== undefined && !validAttempt(data.attempt))
          throw new Error("Invalid handoff attempt");
        state.attempt = data.attempt ?? 1;
        const pending = data.pendingMessage;
        if (pending !== undefined && (!validPending(pending) || pending.delivery !== "pending"))
          throw new Error("Invalid handoff");
        state.pendingMessage = pending;
      }
      persist(ctx, {});
      if (conversation || tree || previouslyProbed)
        fail(ctx, "unverified_branch_requires_new_session", false);
      else if (!config.enabled) fail(ctx, "probe_disabled_with_handoff", false);
      else askQuestion(ctx);
    } catch (error) {
      fault = true;
      notify(ctx, `无法初始化检测/交接，任务已阻止：${errorText(error)}`, true);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    workloopGates.set(ctx.sessionManager.getSessionId(), gateWorkloopCommand);
    return restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    workloopGates.set(ctx.sessionManager.getSessionId(), gateWorkloopCommand);
    return restore(ctx, true);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (workloopGates.get(ctx.sessionManager.getSessionId()) === gateWorkloopCommand)
      workloopGates.delete(ctx.sessionManager.getSessionId());
    generation++;
    stop();
    loading = true;
    if (ctx.mode === "tui") ctx.ui.setStatus(QUESTION, undefined);
  });
  pi.on("model_select", (_event, ctx) => {
    if (restoringSelection) return;
    if (!applies(ctx)) {
      if (state && state.model !== modelKey(ctx)) {
        stop();
        persist(ctx, { phase: "FAILED", reason: "model_changed" });
      }
      return restore(ctx);
    }
    if (!state) return restore(ctx);
    if (state.model === modelKey(ctx)) return;
    ctx.abort();
    fail(ctx, "model_changed", false);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (restoringSelection || !applies(ctx) || !state || state.model === modelKey(ctx)) return;
    ctx.abort();
    fail(ctx, "thinking_level_changed", false);
  });
  pi.on("input", (event, ctx) => {
    if (
      pendingConfig &&
      enabled &&
      applies(ctx) &&
      !blocked(ctx) &&
      event.source !== "extension" &&
      !event.streamingBehavior &&
      ctx.isIdle() &&
      (event.text.trim() || event.images?.length) &&
      (!event.text.trimStart().startsWith("/") ||
        event.text.trimStart().startsWith("/skill:gkd-workloop ")) &&
      !hasConversation(ctx)
    ) {
      state = {
        version: 1,
        sessionId: liveSession,
        runId: randomUUID(),
        phase: "PENDING",
        config: { ...pendingConfig, enabled },
        model: modelKey(ctx),
        index: 0,
        results: [],
      };
      pendingConfig = undefined;
    }
    const pending = state?.pendingMessage;
    if (
      state?.phase === "DELIVERING" &&
      !deliveryAccepted &&
      event.source === "extension" &&
      pending &&
      event.text === pending.text &&
      JSON.stringify(event.images ?? []) === JSON.stringify(pending.images)
    ) {
      deliveryAccepted = true;
      return;
    }
    if (!blocked(ctx)) return;
    if (state?.phase === "RESTARTING") {
      notify(ctx, "会话正在重建，本次输入未保存；请在新会话中重发。", true);
      return { action: "handled" };
    }
    if (state && event.source !== "extension" && (event.text.trim() || event.images?.length)) {
      if (pending && pending.delivery !== "delivered")
        notify(ctx, "已有待处理消息，本次输入未保存；请等待或新建会话。", true);
      else {
        try {
          persist(ctx, {
            pendingMessage: {
              id: randomUUID(),
              text: event.text,
              images: event.images ?? [],
              delivery: "pending",
            },
          });
          notify(ctx, "消息已暂存，检测通过前不会执行。");
          if (state.phase === "PENDING") askQuestion(ctx);
        } catch {
          /* Persistence failure already closes the gate. */
        }
      }
    } else notify(ctx, "检测未通过，已阻止本次 Agent 输入。", true);
    return { action: "handled" };
  });
  pi.on("before_agent_start", (event, ctx) => {
    const details =
      event.messageType === "custom"
        ? (event.message.details as { runId?: string; index?: number } | undefined)
        : undefined;
    if (
      active &&
      state?.phase === "TESTING" &&
      current(ctx) &&
      event.messageType === "custom" &&
      event.message.customType === QUESTION &&
      details?.runId === active.runId &&
      details.index === active.index &&
      modelKey(ctx) === state.model
    ) {
      active.started = true;
      promptOptions = event.systemPromptOptions;
      promptOptions.forceSystemPrompt = "";
      return;
    }
    if (deliveryAccepted && state?.phase === "DELIVERING") return;
    if (blocked(ctx)) {
      // Also catches custom-message and slash-command runs which bypass input handlers.
      ctx.abort();
      notify(ctx, "检测未通过，已阻止正常 Agent 回合（扩展命令本身不在此门禁内）。", true);
    }
  });
  pi.on("agent_start", () => {
    if (active?.started || deliveryAccepted) clearTimeout(startupTimer);
  });
  pi.on("context_with_system", (_event, ctx) => {
    if (!active?.started || !state || state.phase !== "TESTING" || !current(ctx)) return;
    if (modelKey(ctx) !== state.model) {
      ctx.abort();
      fail(ctx, "model_changed", false);
      return;
    }
    if (promptOptions) promptOptions.forceSystemPrompt = "";
    // Request-only projection: no global setActiveTools(), no history/answers/extension context leakage.
    return {
      messages: [
        { role: "system" as const, content: "", timestamp: Date.now() },
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: state.config.questions[active.index].question }],
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.on("before_provider_request", (event) => {
    if (
      !active?.started ||
      state?.phase !== "TESTING" ||
      !event.payload ||
      typeof event.payload !== "object"
    )
      return;
    // Codex's serializer substitutes a default instruction for an empty system prompt.
    const payload = { ...event.payload };
    if ("instructions" in payload) payload.instructions = "";
    if ("tools" in payload) payload.tools = [];
    return payload;
  });
  pi.on("tool_call", (_event, ctx) =>
    blocked(ctx)
      ? { block: true, reason: "Model Probe has not passed", terminate: true }
      : undefined,
  );
  pi.on("message_end", (event, ctx) => {
    if (!current(ctx)) return;
    if (
      deliveryAccepted &&
      state?.phase === "DELIVERING" &&
      event.message.role === "user" &&
      state.pendingMessage
    ) {
      persist(ctx, {
        phase: "READY",
        pendingMessage: { ...state.pendingMessage, delivery: "delivered" },
      });
      deliveryAccepted = false;
    }
    if (
      !active?.started ||
      !state ||
      state.phase !== "TESTING" ||
      event.message.role !== "assistant"
    )
      return;
    const message = event.message;
    active.answer = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    active.error ??=
      message.stopReason === "error"
        ? `provider_error: ${message.errorMessage ?? "unknown"}`
        : message.stopReason === "aborted"
          ? "aborted"
          : message.content.some((part) => part.type === "toolCall")
            ? "unexpected_tool_call"
            : message.stopReason !== "stop"
              ? `incomplete_response: ${message.stopReason}`
              : undefined;
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (current(ctx) && state?.phase === "DELIVERING") {
      fail(ctx, "pending_message_not_accepted", false);
      return;
    }
    if (!active?.started || !state || state.phase !== "TESTING" || !current(ctx)) return;
    const run = active;
    active = undefined;
    const reason = event.aborted
      ? "aborted"
      : (run.error ?? (modelKey(ctx) !== state.model ? "model_changed" : undefined));
    const result = reason
      ? {
          questionId: state.config.questions[run.index].id,
          actual: run.answer ?? "",
          passed: false,
          reason,
        }
      : validateAnswer(state.config.questions[run.index], run.answer ?? "");
    persist(ctx, { results: [...state.results, result] });
    if (!result.passed) {
      fail(ctx, result.reason ?? "answer_mismatch", false);
      if (
        !fault &&
        result.reason !== "aborted" &&
        applies(ctx) &&
        modelKey(ctx) === state.model &&
        (state.attempt ?? 1) < state.config.maxAttempts
      ) {
        notify(
          ctx,
          `自动新建会话重测（第 ${(state.attempt ?? 1) + 1}/${state.config.maxAttempts} 轮）。`,
        );
        requestRestart(ctx, (state.attempt ?? 1) + 1);
      } else await offerFailureAction(ctx);
      return;
    }
    if (run.index + 1 < state.config.questions.length) {
      persist(ctx, { index: run.index + 1 });
      askQuestion(ctx);
    } else {
      persist(ctx, { phase: "PASSED" });
      notify(ctx, "回答正确");
      deliver(ctx);
    }
  });
  pi.registerCommand(RESTART, {
    description: "Internal Model Probe session restart",
    handler: async (args, ctx) => {
      if (
        !restartToken ||
        args !== restartToken.token ||
        state?.phase !== "FAILED" ||
        !current(ctx)
      )
        return;
      const { attempt } = restartToken;
      restartToken = undefined;
      if (!ctx.model) {
        fail(ctx, "model_missing", false);
        return;
      }
      const selection: ProbeHandoff["selection"] = {
        provider: ctx.model.provider,
        id: ctx.model.id,
        api: ctx.model.api,
        thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
      };
      const pending =
        state.pendingMessage?.delivery === "pending" ? state.pendingMessage : undefined;
      const version = generation;
      persist(ctx, {
        phase: "RESTARTING",
        pendingMessage: pending ? { ...pending, delivery: "transferred" } : state.pendingMessage,
      });
      try {
        const result = await ctx.newSession({
          setup: async (manager) => {
            manager.appendCustomEntry(`${PROBE_ENTRY}:setting`, { enabled: true });
            manager.appendCustomEntry(HANDOFF_ENTRY, {
              pendingMessage: pending,
              attempt,
              selection,
            });
          },
        });
        // A successful replacement invalidates this entire instance. Never touch it afterwards.
        if (result.cancelled && current(ctx, version)) {
          persist(ctx, { pendingMessage: pending ?? state?.pendingMessage });
          fail(ctx, "restart_cancelled", false);
        }
      } catch (error) {
        if (current(ctx, version)) {
          persist(ctx, { pendingMessage: pending ?? state?.pendingMessage });
          fail(ctx, `restart_failed: ${errorText(error)}`, false);
        }
      }
    },
  });

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value: boolean, ctx: ExtensionContext) {
      pi.appendEntry(`${PROBE_ENTRY}:setting`, { enabled: value });
      enabled = value;
      updateStatus(ctx);
    },
  };
}
