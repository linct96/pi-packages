import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { isActionableDevelopmentRequest } from "./intent.ts";
import { readSettings, writeSettings } from "./settings.ts";

type Mode = "auto" | "fast" | "standard";
type Phase = "running" | "plan_review" | "blocked" | "completed" | "review_required" | "stopped";
type State = {
  version: 1;
  task: string;
  mode: Mode;
  phase: Phase;
  iteration: number;
  maxIterations: number;
  failedValidations: number;
  sessionId: string;
  planPath?: string;
  summary?: string;
  lastChecks?: Array<{ command: string; ok: boolean; output: string }>;
};

type Config = { validators?: string[]; validationTimeoutMs?: number };

function statePath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "dev-workflow", "state.json");
}

async function loadState(cwd: string): Promise<State | null> {
  try {
    const data = JSON.parse(await readFile(statePath(cwd), "utf8")) as State;
    if (data.version !== 1 || !data.task || !data.sessionId) return null;
    return data;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function saveState(cwd: string, state: State): Promise<void> {
  const path = statePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  // Atomic replace to avoid incomplete JSON after process termination.
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temporary, path);
}

async function readConfig(cwd: string, trusted: boolean): Promise<Config> {
  if (!trusted) return {};
  try {
    const parsed = JSON.parse(await readFile(join(cwd, CONFIG_DIR_NAME, "dev-workflow.config.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const validators = Array.isArray(parsed.validators)
      ? parsed.validators.filter((c: unknown) => typeof c === "string" && c.trim().length > 0).slice(0, 10)
      : [];
    const t = Number(parsed.validationTimeoutMs);
    return {
      validators,
      validationTimeoutMs: Number.isFinite(t) && t >= 1000 && t <= 300000 ? t : 120000,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function parseStart(input: string): { task: string; mode: Mode; maxIterations: number } {
  let mode: Mode = "auto";
  let maxIterations = 0;
  const words = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const kept: string[] = [];
  for (const token of words) {
    if (token === "--fast") mode = "fast";
    else if (token === "--standard") mode = "standard";
    else if (/^--max=\d+$/.test(token)) maxIterations = Number(token.slice(6));
    else kept.push(token);
  }
  return {
    task: kept.join(" ").trim(),
    mode,
    maxIterations: Math.min(100, Math.max(1, maxIterations || (mode === "fast" ? 4 : 25))),
  };
}

const ACTIVE_PHASES = new Set<Phase>(["running", "plan_review", "blocked"]);

function initialState(task: string, mode: Mode, maxIterations: number, sessionId: string): State {
  return {
    version: 1,
    task,
    mode,
    phase: "running",
    iteration: 1,
    maxIterations,
    failedValidations: 0,
    sessionId,
  };
}

function kickoffText(task: string, source: "manual" | "automatic"): string {
  return `/skill:dev-workflow ${task}\n\n` +
    `Dev workflow activated by ${source} start. Inspect relevant code before classifying. ` +
    `Call dev_workflow_report(kind="mode",mode="fast"|"standard",summary="...reasons...") before changing code. ` +
    `Use dev_workflow_report for plan-ready, complete, blocked or escalate. ` +
    `STANDARD requires a reviewed plan and /develop-approve; never claim unrun tests passed.`;
}

function describe(state: State): string {
  return [
    `mode=${state.mode}`,
    `phase=${state.phase}`,
    `iteration=${state.iteration}/${state.maxIterations}`,
    `failedValidators=${state.failedValidations}`,
    state.planPath ? `plan=${state.planPath}` : "",
    state.summary ? `summary=${state.summary}` : "",
  ].filter(Boolean).join(" | ");
}

function validRepoFile(cwd: string, candidate: string): string | null {
  if (!candidate || isAbsolute(candidate)) return null;
  const path = resolve(cwd, candidate);
  if (relative(cwd, path).startsWith("..")) return null;
  return path;
}

export default function devWorkflow(pi: ExtensionAPI) {
  pi.registerCommand("develop", {
    description: "Start FAST or STANDARD coding workflow: /develop [--fast|--standard] [--max=N] <task>",
    handler: async (args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Project must be trusted before running development automation.", "error");
        return;
      }
      const current = await loadState(ctx.cwd);
      if (current && ACTIVE_PHASES.has(current.phase)) {
        ctx.ui.notify(`Existing ${current.phase} workflow. Use /develop-stop or /develop-resume before starting a new one.`, "warning");
        return;
      }
      const parsed = parseStart(args);
      if (!parsed.task) {
        ctx.ui.notify("Usage: /develop [--fast|--standard] [--max=N] <task or PR/MR URL>", "warning");
        return;
      }
      const state = initialState(parsed.task, parsed.mode, parsed.maxIterations, ctx.sessionManager.getSessionId());
      await saveState(ctx.cwd, state);
      ctx.ui.setStatus("dev-workflow", `DEV ${state.mode} 1/${state.maxIterations}`);
      pi.sendUserMessage(kickoffText(state.task, "manual"), { expandPromptTemplates: true });
    },
  });

  // Extension-specific settings: default is manual-only. Does not mutate Pi's built-in /settings.
  pi.registerCommand("develop-settings", {
    description: "Configure dev-workflow: /develop-settings [auto on|auto off|status]",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      const settings = await readSettings();
      if (requested === "status" || requested === "show") {
        ctx.ui.notify(`Auto start: ${settings.autoStart ? "ON" : "OFF"} (default OFF). Settings: ~/.pi/agent/dev-workflow/settings.json (or PI_CODING_AGENT_DIR).`, "info");
        return;
      }
      let enabled: boolean;
      if (["auto on", "on", "auto enable", "enable"].includes(requested)) enabled = true;
      else if (["auto off", "off", "auto disable", "disable"].includes(requested)) enabled = false;
      else if (!requested && ctx.hasUI) {
        const picked = await ctx.ui.select("Dev workflow automatic activation", [
          "Manual only (default)",
          "Auto: detect actionable development requests",
        ]);
        if (!picked) return;
        enabled = picked.startsWith("Auto:");
      } else {
        ctx.ui.notify("Usage: /develop-settings [auto on|auto off|status]. Without args opens the settings menu (TUI/RPC).", "warning");
        return;
      }
      await writeSettings({ version: 1, autoStart: enabled });
      const state = await loadState(ctx.cwd);
      if (!state || !ACTIVE_PHASES.has(state.phase)) ctx.ui.setStatus("dev-workflow", enabled ? "DEV AUTO ON" : undefined);
      ctx.ui.notify(
        enabled
          ? "Dev workflow automatic activation ON. Actionable development prompts will be routed; non-development requests pass through."
          : "Dev workflow automatic activation OFF. Use /develop to start manually.",
        "info",
      );
    },
  });

  // Only intercept direct user prompts when explicitly enabled. No extra model request
  // or background tasks are created merely by installation.
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.streamingBehavior || !ctx.isProjectTrusted()) return { action: "continue" };
    if (!isActionableDevelopmentRequest(event.text)) return { action: "continue" };
    const settings = await readSettings();
    if (!settings.autoStart) return { action: "continue" };
    const current = await loadState(ctx.cwd);
    if (current && ACTIVE_PHASES.has(current.phase)) return { action: "continue" };
    const state = initialState(event.text.trim(), "auto", 25, ctx.sessionManager.getSessionId());
    await saveState(ctx.cwd, state);
    ctx.ui.setStatus("dev-workflow", `DEV auto 1/${state.maxIterations}`);
    ctx.ui.notify("Development intent detected. Inspecting code to select FAST or STANDARD.", "info");
    return { action: "transform", text: kickoffText(state.task, "automatic"), images: event.images };
  });

  pi.on("session_start", async (_event, ctx) => {
    const state = await loadState(ctx.cwd);
    if (state && ACTIVE_PHASES.has(state.phase) && state.sessionId === ctx.sessionManager.getSessionId()) {
      ctx.ui.setStatus("dev-workflow", `DEV ${state.phase} ${state.iteration}/${state.maxIterations}`);
    } else if ((await readSettings()).autoStart) {
      ctx.ui.setStatus("dev-workflow", "DEV AUTO ON");
    }
  });

  pi.registerCommand("develop-status", {
    description: "Show the current development workflow's persisted state",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      ctx.ui.notify(state ? describe(state) : "No development workflow state found.", "info");
    },
  });

  pi.registerCommand("develop-stop", {
    description: "Stop automatic continuation (does not cancel the current model/tool call)",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      if (state) {
        state.phase = "stopped";
        await saveState(ctx.cwd, state);
      }
      ctx.ui.setStatus("dev-workflow", (await readSettings()).autoStart ? "DEV AUTO ON" : undefined);
      ctx.ui.notify("Auto-continuation stopped. Any current model/tool call may still finish.", "info");
    },
  });

  pi.registerCommand("develop-approve", {
    description: "Approve the reviewed STANDARD plan and resume implementation",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      if (!state || state.phase !== "plan_review" || !state.planPath) {
        ctx.ui.notify("No plan awaiting approval.", "warning");
        return;
      }
      const plan = validRepoFile(ctx.cwd, state.planPath);
      if (!plan) {
        ctx.ui.notify("Plan path must be relative to the project.", "error");
        return;
      }
      try { await access(plan); } catch {
        ctx.ui.notify("Plan file does not exist. Approval rejected.", "error");
        return;
      }
      state.phase = "running";
      state.sessionId = ctx.sessionManager.getSessionId();
      await saveState(ctx.cwd, state);
      pi.sendUserMessage(
        `The user approved the STANDARD plan at ${state.planPath}. Implement the next pending step, verify it, and update the execution log. ` +
        `Report complete using dev_workflow_report only when all acceptance criteria are satisfied.`,
        { expandPromptTemplates: false },
      );
    },
  });

  pi.registerCommand("develop-resume", {
    description: "Resume a paused or previously stopped workflow (except plan review)",
    handler: async (_args, ctx) => {
      const state = await loadState(ctx.cwd);
      if (!state || (state.phase !== "blocked" && state.phase !== "stopped")) {
        ctx.ui.notify("No stopped or blocked workflow to resume.", "warning");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Project must be trusted.", "error");
        return;
      }
      state.phase = "running";
      state.sessionId = ctx.sessionManager.getSessionId();
      state.iteration = 1;
      state.failedValidations = 0;
      await saveState(ctx.cwd, state);
      pi.sendUserMessage(
        `Resume the development workflow for: ${state.task}. Mode=${state.mode}. ` +
        `Read existing plan and repository state; preserve existing changes. Verify the next pending step. ` +
        `Use dev_workflow_report to signal plan-ready, complete, blocked, or escalate.`,
      );
    },
  });

  pi.registerTool({
    name: "dev_workflow_report",
    label: "Development Workflow Report",
    description: "Update the bounded development workflow status. Signal mode selection, finished plan requiring approval, completion, blocker, or FAST-to-STANDARD escalation. Completion runs configured independent validators.",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("mode"), Type.Literal("plan-ready"), Type.Literal("complete"),
        Type.Literal("blocked"), Type.Literal("escalate"),
      ]),
      mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("standard")])),
      planPath: Type.Optional(Type.String()),
      summary: Type.String({ description: "Factual summary and evidence, or the precise blocker" }),
    }),
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      const state = await loadState(ctx.cwd);
      const respond = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: {} });
      if (!state || state.sessionId !== ctx.sessionManager.getSessionId() || state.phase !== "running") {
        return respond("No active development workflow in this session; no status change made.");
      }
      if (state.mode === "auto" && args.kind !== "mode" && args.kind !== "blocked") {
        return respond("Select FAST or STANDARD with kind=mode after inspecting the code before any other workflow report.");
      }
      state.summary = args.summary;
      if (args.kind === "mode") {
        if (!args.mode) return respond("mode is required for kind=mode.");
        if (state.mode !== "auto" && state.mode !== args.mode) {
          return respond(`Mode is forced to ${state.mode}; to change modes, explicitly restart the workflow.`);
        }
        state.mode = args.mode;
        if (args.mode === "fast") state.maxIterations = Math.min(state.maxIterations, 4);
        await saveState(ctx.cwd, state);
        return respond(`Mode selected: ${args.mode}. ${describe(state)}`);
      }
      if (args.kind === "escalate") {
        if (state.mode === "standard") return respond("Already STANDARD; report a specific blocker if needed.");
        state.mode = "standard";
        state.maxIterations = Math.max(state.maxIterations, 25);
        await saveState(ctx.cwd, state);
        return respond("Escalated to STANDARD. Locate an existing PR/MR or request authorization to create one, then prepare a plan and call plan-ready. Do not implement before approval.");
      }
      if (args.kind === "plan-ready") {
        if (state.mode !== "standard") return respond("plan-ready is available only in STANDARD mode.");
        const path = validRepoFile(ctx.cwd, args.planPath ?? "");
        if (!path) return respond("Provide a planPath relative to the current repository directory.");
        try { await access(path); } catch { return respond("Plan file not found; cannot request plan approval."); }
        state.planPath = args.planPath;
        state.phase = "plan_review";
        await saveState(ctx.cwd, state);
        ctx.ui.setStatus("dev-workflow", "DEV plan review");
        return respond(`Plan prepared: ${args.planPath}. Automatic execution paused. User must review and enter /develop-approve.`);
      }
      if (args.kind === "blocked") {
        state.phase = "blocked";
        await saveState(ctx.cwd, state);
        ctx.ui.setStatus("dev-workflow", "DEV blocked");
        return respond("Workflow paused as blocked. Explain the blocker to the user. Resume requires /develop-resume.");
      }
      // Completion: run independent validators from trusted project configuration.
      const config = await readConfig(ctx.cwd, ctx.isProjectTrusted());
      const commands = config.validators ?? [];
      if (!commands.length) {
        state.phase = "review_required";
        await saveState(ctx.cwd, state);
        ctx.ui.setStatus("dev-workflow", "DEV review required");
        return respond("Implementation reported complete, but no independent validators configured. Auto-loop stopped as review_required, NOT verified. Manually review tests and results; configure validators in .pi/dev-workflow.config.json for independent checks.");
      }
      const checks: Array<{ command: string; ok: boolean; output: string }> = [];
      for (const command of commands) {
        if (signal.aborted) return respond("Validation interrupted; completion not recorded.");
        try {
          const result = await pi.exec("sh", ["-lc", command], {
            cwd: ctx.cwd,
            signal,
            timeout: config.validationTimeoutMs ?? 120000,
            maxBuffer: 65536,
          });
          checks.push({
            command,
            ok: result.code === 0 && !result.killed && !result.truncated,
            output: `${result.stdout}\n${result.stderr}`.slice(-1600),
          });
        } catch (error) {
          checks.push({ command, ok: false, output: String(error).slice(-1600) });
        }
        if (!checks[checks.length - 1].ok) break;
      }
      state.lastChecks = checks;
      if (checks.every((check) => check.ok)) {
        state.phase = "completed";
        await saveState(ctx.cwd, state);
        ctx.ui.setStatus("dev-workflow", "DEV checks passed");
        return respond(`Independent validators passed. Workflow completed. ${checks.map(c => c.command).join("; ")}. Do not merge automatically.`);
      }
      state.failedValidations++;
      if (state.failedValidations >= 3) state.phase = "blocked";
      await saveState(ctx.cwd, state);
      const failed = checks.find(c => !c.ok)!;
      return respond(`Validator FAILED: ${failed.command}\n${failed.output}\nAttempt ${state.failedValidations}/3. ${state.phase === "blocked" ? "Stopped after repeated failures." : "Diagnose, fix and rerun checks before reporting complete."}`);
    },
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const state = await loadState(ctx.cwd);
    if (!state || state.phase !== "running" || state.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (state.iteration >= state.maxIterations) {
      state.phase = "blocked";
      state.summary = `Stopped at max iterations (${state.maxIterations}).`;
      await saveState(ctx.cwd, state);
      ctx.ui.setStatus("dev-workflow", "DEV max iterations");
      return;
    }
    state.iteration++;
    await saveState(ctx.cwd, state);
    ctx.ui.setStatus("dev-workflow", `DEV ${state.mode} ${state.iteration}/${state.maxIterations}`);
    return {
      entries: [...event.entries, {
        type: "custom_message" as const,
        customType: "dev-workflow-continuation",
        content: `Continue work on: ${state.task}. Mode=${state.mode}. Loop ${state.iteration}/${state.maxIterations}. ` +
          `Inspect actual progress, execute one next incomplete step, verify changes. ` +
          `If finished use dev_workflow_report(kind="complete"); if plan ready, blocked or requiring escalation, report with the matching kind. ` +
          `Do not repeat failed actions without diagnosis and never claim unrun tests passed.`,
        display: false,
      }],
      continue: true,
    };
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!event.aborted) return;
    const state = await loadState(ctx.cwd);
    if (!state || state.phase !== "running" || state.sessionId !== ctx.sessionManager.getSessionId()) return;
    state.phase = "stopped";
    state.summary = "Model run aborted by user or host.";
    await saveState(ctx.cwd, state);
    ctx.ui.setStatus("dev-workflow", (await readSettings()).autoStart ? "DEV AUTO ON" : undefined);
  });
}
