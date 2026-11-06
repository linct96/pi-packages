import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import {
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { registerJudgeRoute } from "./judge-route/index.ts";
import {
  loadState,
  reportTextSchema,
  saveState,
  statePath,
  terminal,
  transition,
  type Phase,
  type TaskState,
} from "./state.ts";

const INSTRUCTIONS = readFileSync(new URL("./workflow.md", import.meta.url), "utf8").trim();
const ENTRY = "gkd-task";
const REPORT = "gkd_report";
const EVIDENCE = "gkd_route_evidence";
const base = { taskId: Type.String(), planVersion: Type.Integer({ minimum: 0 }) };
const reportSchema = Type.Union([
  Type.Object(
    { ...base, action: Type.Literal("plan"), plan: reportTextSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...base, action: Type.Literal("implemented"), summary: reportTextSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...base,
      action: Type.Literal("verified"),
      passed: Type.Boolean(),
      summary: reportTextSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...base,
      action: Type.Union([Type.Literal("blocked"), Type.Literal("reevaluate")]),
      reason: reportTextSchema,
    },
    { additionalProperties: false },
  ),
]);

export function registerWorkflow(
  pi: ExtensionAPI,
  autoEnabled: (ctx: ExtensionContext) => boolean,
) {
  let state: TaskState | undefined;
  let engaged = false;
  let originalTools: string[] | undefined;
  let fault = false;
  let promptController = new AbortController();
  let nudged = false;
  let draining = false;
  const owns = (ctx: ExtensionContext) =>
    !!state && state.sessionId === ctx.sessionManager.getSessionId();
  const running = (ctx: ExtensionContext) => engaged && owns(ctx);
  const router = registerJudgeRoute(pi, {
    canDebug: () => !engaged,
    allowEvidence: (ctx) => running(ctx) && state?.phase !== "ROUTING",
  });

  function status(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      "gkd-workflow",
      owns(ctx) ? `GKD · ${state!.route ?? "—"} · ${state!.phase}` : undefined,
    );
  }
  function release(ctx: ExtensionContext) {
    draining ||= engaged && !ctx.isIdle();
    engaged = false;
    promptController.abort();
    router.stop();
    if (originalTools) pi.setActiveTools(originalTools);
    originalTools = undefined;
    status(ctx);
  }
  function permissions(ctx: ExtensionContext) {
    if (!running(ctx)) return;
    const phase = state!.phase;
    if (fault) pi.setActiveTools([]);
    else if (phase === "ROUTING") return; // The shared router owns its two-tool loadout.
    else if (phase === "IMPLEMENTING" || phase === "VERIFYING")
      pi.setActiveTools([...new Set([...(originalTools ?? []), EVIDENCE, REPORT])]);
    else pi.setActiveTools([EVIDENCE, REPORT]);
    status(ctx);
  }
  function commit(next: TaskState, ctx: ExtensionContext) {
    try {
      saveState(next);
    } catch (error) {
      fault = true;
      pi.setActiveTools([]);
      ctx.ui.notify(
        "GKD 状态保存失败；已锁住本轮工具。请处理存储问题后重新加载并恢复任务。",
        "error",
      );
      throw error;
    }
    state = next;
    nudged = false;
    status(ctx);
  }
  function move(phase: Phase, ctx: ExtensionContext, patch: Partial<TaskState> = {}) {
    if (!state) throw new Error("No GKD task");
    commit(transition(state, phase, patch), ctx);
    if (["PAUSED", "BLOCKED", "COMPLETED", "CANCELLED"].includes(phase)) release(ctx);
    else permissions(ctx);
  }
  function describe() {
    const page = truncateHead(
      INSTRUCTIONS + "\n\nCurrent GKD task:\n" + JSON.stringify(state, null, 2),
    );
    return (
      page.content +
      (page.truncated
        ? "\n[GKD context truncated; refer to the original task/plan messages. Do not invent omitted requirements.]"
        : "")
    );
  }
  function pause(ctx: ExtensionContext, reason: string) {
    if (!owns(ctx) || !state || terminal(state.phase) || state.phase === "PAUSED") return;
    const phase = state.phase;
    move("PAUSED", ctx, {
      resumePhase: phase === "BLOCKED" ? (state.resumePhase ?? "ROUTING") : phase,
      approval: null,
      validation: null,
      reason: phase === "BLOCKED" ? `${reason} 原阻塞原因：${state.reason}` : reason,
    });
  }
  async function routed(result: Record<string, unknown>, ctx: ExtensionContext) {
    if (!running(ctx) || state?.phase !== "ROUTING") throw new Error("GKD route request expired");
    if (result.status !== "ok") {
      move("BLOCKED", ctx, { reason: `Route failed: ${result.error}`, resumePhase: "ROUTING" });
      return "\nGKD BLOCKED; wait for the user.";
    }
    if (result.route !== "FAST" && result.route !== "STANDARD") {
      const task = state;
      release(ctx);
      unlinkSync(statePath(task.sessionId, task.taskId));
      state = undefined;
      pi.appendEntry(ENTRY, { taskId: null });
      status(ctx);
      return `\nNo development FSM for ${result.route}. Original task: ${JSON.stringify(task.task)}. Respond using ordinary conversation/operation authorization; classification is not permission to execute.`;
    }
    move(result.route === "STANDARD" ? "PLANNING" : "IMPLEMENTING", ctx, {
      route: result.route,
      reason: "",
    });
    return "\n" + describe();
  }
  function startRouting(ctx: ExtensionContext, inlinePrompt?: string) {
    router.start(state!.task, ctx, routed, inlinePrompt);
    status(ctx);
  }
  function approve(ctx: ExtensionContext, taskId: string, version: number) {
    if (
      !running(ctx) ||
      state?.phase !== "AWAITING_APPROVAL" ||
      state.taskId !== taskId ||
      state.planVersion !== version
    )
      return false;
    move("IMPLEMENTING", ctx, { approval: { taskId, planVersion: version }, reason: "" });
    return true;
  }

  function start(task: string, ctx: ExtensionContext, inlinePrompt?: string) {
    if (!task || task.length > 16000) {
      ctx.ui.notify("用法：/gkd <任务>（最多 16000 字符）", "warning");
      return;
    }
    if (!ctx.isIdle() || router.isActive() || (state && !terminal(state.phase))) {
      ctx.ui.notify("已有任务尚未结束；可以说“继续上次任务”或“取消当前任务”。", "warning");
      return;
    }
    if (!ctx.model || !ctx.isProjectTrusted()) {
      ctx.ui.notify("GKD 需要可用模型和可信项目。", "error");
      return;
    }
    try {
      const cwd = realpathSync(ctx.cwd);
      originalTools = pi
        .getActiveTools()
        .filter((name) => ![REPORT, EVIDENCE, "gkd_judge_route"].includes(name));
      commit(
        {
          version: 2,
          taskId: randomUUID(),
          sessionId: ctx.sessionManager.getSessionId(),
          task,
          cwd,
          tools: originalTools,
          route: null,
          phase: "ROUTING",
          plan: null,
          planVersion: 0,
          approval: null,
          retries: 0,
          implementation: "",
          validation: null,
          resumePhase: null,
          reason: "",
          updatedAt: new Date().toISOString(),
        },
        ctx,
      );
      pi.appendEntry(ENTRY, { taskId: state!.taskId, tools: state!.tools });
      engaged = true;
      fault = false;
      promptController = new AbortController();
      startRouting(ctx, inlinePrompt);
    } catch (error) {
      if (state && !fault) pause(ctx, String(error));
      else release(ctx);
      ctx.ui.notify(`无法启动 GKD：${String(error)}`, "error");
    }
  }
  pi.registerCommand("gkd", {
    description: "启动 FAST / STANDARD 开发工作流",
    handler: async (args, ctx) => start(args.trim(), ctx),
  });

  pi.registerTool({
    name: REPORT,
    label: "GKD 阶段报告",
    defaultActive: false,
    exposure: "model-only",
    executionMode: "sequential",
    description:
      "Report plan, implemented, verified, blocked or reevaluate for the current taskId and planVersion. plan is Markdown and requires user approval on STANDARD. implemented summarizes actual work. verified reports passed and a summary of actual test outcomes and acceptance checks; the main Agent judges them, not the Extension. Never sets phases or approvals. Call separately after other tools finish.",
    parameters: reportSchema,
    async execute(_id, args, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(reportSchema, args) || !running(ctx) || !state || fault)
        throw new Error("No active GKD report permission");
      if (args.taskId !== state.taskId || args.planVersion !== state.planVersion)
        throw new Error("Stale GKD task/plan report");
      if (args.action === "blocked") {
        move("BLOCKED", ctx, { reason: args.reason, resumePhase: state.phase, approval: null });
      } else if (args.action === "reevaluate") {
        if (state.phase !== "IMPLEMENTING" && state.phase !== "VERIFYING")
          throw new Error("Replanning requires IMPLEMENTING or VERIFYING");
        move("PLANNING", ctx, {
          route: "STANDARD",
          approval: null,
          validation: null,
          implementation: "",
          reason: args.reason,
        });
      } else if (args.action === "plan") {
        if (state.phase !== "PLANNING" && state.phase !== "AWAITING_APPROVAL")
          throw new Error("Plan report requires PLANNING");
        if (state.phase === "AWAITING_APPROVAL") move("PLANNING", ctx, { approval: null });
        move("AWAITING_APPROVAL", ctx, {
          plan: args.plan,
          planVersion: state.planVersion + 1,
          approval: null,
          validation: null,
        });
        const current = state;
        pi.sendMessage(
          {
            customType: "gkd-plan",
            content: `GKD 计划 · ${current.taskId} · v${current.planVersion}\n${current.plan}\n请确认当前计划；也可以回复“批准当前计划”。`,
            display: true,
          },
          { triggerTurn: false },
        );
        if (ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            `批准 GKD 计划 v${current.planVersion}？`,
            `${current.taskId}\n${current.plan}`,
            {
              signal: AbortSignal.any([promptController.signal, ...(signal ? [signal] : [])]),
            },
          );
          signal?.throwIfAborted();
          if (ok) approve(ctx, current.taskId, current.planVersion);
        }
      } else if (args.action === "implemented") {
        if (state.phase !== "IMPLEMENTING")
          throw new Error("Implementation report requires IMPLEMENTING");
        move("VERIFYING", ctx, { implementation: args.summary, validation: null });
      } else if (args.action === "verified") {
        if (state.phase !== "VERIFYING") throw new Error("Verification report requires VERIFYING");
        const validation = { passed: args.passed, summary: args.summary };
        // shortcut: acceptance is the main Agent's judgment; add independent evidence gates only if a future workflow requires them.
        if (args.passed)
          move("COMPLETED", ctx, {
            validation,
            reason: "Main Agent reported verification and acceptance complete",
          });
        else if (state.retries < 2)
          move("IMPLEMENTING", ctx, {
            validation,
            retries: state.retries + 1,
            reason: "Verification failed; fix and re-run checks",
          });
        else
          move("BLOCKED", ctx, {
            validation,
            reason: "验证失败，已用完 2 次自动修复机会。",
            resumePhase: "IMPLEMENTING",
            approval: null,
          });
      }
      return {
        content: [{ type: "text", text: describe() }],
        details: { phase: state!.phase, taskId: state!.taskId, planVersion: state!.planVersion },
        terminate: !engaged || state!.phase === "AWAITING_APPROVAL",
      };
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    draining = false;
    if (!running(ctx)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${describe()}` };
  });
  pi.on("tool_call", (event, ctx) => {
    if (!running(ctx)) {
      if (draining && owns(ctx))
        return {
          block: true,
          reason: "GKD ended or paused; wait for the current run to settle",
          terminate: true,
        };
      if (event.toolName === REPORT)
        return { block: true, reason: "No active GKD task", terminate: true };
      return;
    }
    const phase = state!.phase;
    const deny = (reason: string) => ({ block: true as const, reason });
    if (fault || ctx.signal?.aborted) return deny("GKD is interrupted or persistence failed");
    if (phase === "ROUTING")
      return [EVIDENCE, "gkd_judge_route"].includes(event.toolName)
        ? undefined
        : deny("GKD routing only permits its evidence and classification tools");
    if (event.toolName === REPORT || event.toolName === EVIDENCE) return;
    if (
      (phase === "IMPLEMENTING" || phase === "VERIFYING") &&
      originalTools?.includes(event.toolName)
    )
      return;
    return deny(
      "GKD blocks execution and writes before plan approval / outside development stages",
    );
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return;
    const text = event.text.trim();
    if (!owns(ctx) || !state || terminal(state.phase)) {
      if (
        !text ||
        text.startsWith("/") ||
        text.startsWith("!") ||
        event.streamingBehavior ||
        !ctx.isIdle() ||
        router.isActive()
      )
        return;
      try {
        if (!autoEnabled(ctx)) return;
      } catch (error) {
        ctx.ui.notify(
          `无法读取 GKD 自动启用设置，未执行本次输入；请修复设置或手动使用 /gkd：${String(error)}`,
          "error",
        );
        return { action: "handled" };
      }
      start(text, ctx, event.text);
      return { action: running(ctx) ? "continue" : "handled" };
    }
    if (/^(取消当前任务|取消上次任务|cancel (?:current )?(?:gkd )?task)[。.!！]?$/i.test(text)) {
      ctx.abort();
      move("CANCELLED", ctx, { approval: null, reason: "User cancelled" });
      return { action: "handled" };
    }
    if (
      /^(批准当前计划|同意当前计划|approve (?:the )?current plan)[。.!！]?$/i.test(text) &&
      running(ctx) &&
      state.phase === "AWAITING_APPROVAL"
    ) {
      approve(ctx, state.taskId, state.planVersion);
      return { action: "transform", text: `GKD 当前计划已由用户批准。\n${describe()}` };
    }
    const resume =
      /^(?:继续上次任务|继续当前任务|恢复上次任务|resume (?:the )?(?:last |current )?(?:gkd )?task)(?:[：:]\s*([\s\S]+))?[。.!！]?$/i.exec(
        text,
      );
    if (resume?.[1] && running(ctx)) {
      const task = `${state.task}\n用户补充：${resume[1]}`;
      if (task.length > 16000) {
        ctx.ui.notify("补充需求超长；请缩短后恢复。", "warning");
        return { action: "handled" };
      }
      if (!ctx.isIdle()) ctx.abort();
      move("BLOCKED", ctx, {
        task,
        route: state.route ? "STANDARD" : null,
        resumePhase: state.route ? "PLANNING" : "ROUTING",
        approval: null,
        validation: null,
        reason: "用户补充需求；恢复后重新规划和审批。",
      });
      return { action: "handled" };
    }
    if (resume && ["PAUSED", "BLOCKED"].includes(state.phase)) {
      if (!ctx.isIdle() || router.isActive()) {
        ctx.ui.notify("请等待被中断的执行退出后再恢复。", "warning");
        return { action: "handled" };
      }
      if (!ctx.isProjectTrusted() || realpathSync(ctx.cwd) !== state.cwd)
        throw new Error("GKD project changed or is not trusted");
      const task = resume[1] ? `${state.task}\n用户补充：${resume[1]}` : state.task;
      if (task.length > 16000) {
        ctx.ui.notify("补充需求超长；请缩短后恢复。", "warning");
        return { action: "handled" };
      }
      originalTools = pi
        .getActiveTools()
        .filter((name) => ![REPORT, EVIDENCE, "gkd_judge_route"].includes(name));
      engaged = true;
      fault = false;
      promptController = new AbortController();
      const phase =
        state.resumePhase === "ROUTING" || !state.route
          ? "ROUTING"
          : state.route === "STANDARD" || resume[1]
            ? "PLANNING"
            : "IMPLEMENTING";
      move(phase, ctx, {
        task,
        route: phase === "PLANNING" ? "STANDARD" : state.route,
        approval: null,
        validation: null,
      });
      if (phase === "ROUTING") {
        startRouting(ctx);
        return { action: "handled" };
      }
      return {
        action: "transform",
        text: `恢复 GKD；先检查实际工作区、中断操作和阻塞条件，不能假定已解决或成功。\n${describe()}`,
      };
    }
    if (
      (resume && !resume[1]) ||
      (running(ctx) &&
        state.phase === "AWAITING_APPROVAL" &&
        /^(好|好的|可以|继续|同意|批准|ok|yes)[。.!！]?$/i.test(text))
    ) {
      ctx.ui.notify(
        state.phase === "AWAITING_APPROVAL"
          ? "请明确回复“批准当前计划”，或在原生确认框批准。"
          : "GKD 任务正在进行。",
        "info",
      );
      return { action: "handled" };
    }
    // Other conversation is neither plan approval nor permission to continue this workflow.
    if (running(ctx)) {
      if (!ctx.isIdle()) ctx.abort();
      pause(ctx, "用户输入其他内容；GKD 已暂停。需求变化请恢复时补充。");
    }
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (
      !running(ctx) ||
      fault ||
      event.outcome !== "completed" ||
      !state ||
      state.phase === "AWAITING_APPROVAL"
    )
      return;
    if (nudged) {
      pause(ctx, "Agent 未上报阶段结果，安全暂停；请继续上次任务。");
      return;
    }
    nudged = true;
    return {
      continue: true,
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "gkd-continue",
          display: false,
          content: `GKD 尚未结束。执行当前阶段并通过 gkd_report 上报；不能完成请报告 blocked。\n${describe()}`,
        },
      ],
    };
  });
  pi.on("agent_settled", (event, ctx) => {
    if (running(ctx) && (event.aborted || state?.phase !== "AWAITING_APPROVAL"))
      pause(ctx, event.aborted ? "Pi 原生中断，可恢复。" : "Agent 已停止，可恢复。");
    draining = false;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    pause(ctx, "会话关闭，可恢复。");
    release(ctx);
  });
  pi.on("session_before_fork", (_event, ctx) => {
    pause(ctx, "会话分叉，原任务暂停；新会话不继承审批。");
  });
  pi.on("session_before_tree", (_event, ctx) => {
    pause(ctx, "会话分支切换，审批失效。");
  });
  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
  });

  function restore(ctx: ExtensionContext) {
    release(ctx);
    state = undefined;
    fault = false;
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((item) => item.type === "custom" && item.customType === ENTRY);
    if (!entry || entry.type !== "custom" || !(entry.data as { taskId?: unknown })?.taskId) {
      status(ctx);
      return;
    }
    try {
      state = loadState(
        ctx.sessionManager.getSessionId(),
        (entry.data as { taskId: string }).taskId,
      );
      pi.setActiveTools(state.tools);
      if (!terminal(state.phase)) {
        if (state.phase !== "PAUSED")
          pause(ctx, "已恢复任务；继续前由主 Agent 重新检查工作区和未完成事项。");
        else commit({ ...state, approval: null, validation: null }, ctx);
      }
      status(ctx);
    } catch (error) {
      state = undefined;
      const tools = (entry.data as { tools?: unknown }).tools;
      if (Array.isArray(tools) && tools.every((tool) => typeof tool === "string"))
        pi.setActiveTools(tools);
      ctx.ui.notify(`GKD 恢复失败，未执行任何任务：${String(error)}`, "error");
      status(ctx);
    }
  }
}
