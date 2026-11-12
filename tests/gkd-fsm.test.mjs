import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import gkdWorkflow from "../extensions/gkd-workflow/index.ts";
import {
  loadState,
  saveState,
  transition,
  validateState,
} from "../extensions/gkd-workflow/state.ts";
import { saveSettings } from "../extensions/gkd-workflow/settings.ts";

const sandbox = await mkdtemp(join(tmpdir(), "gkd-fsm-"));
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
after(() => rm(sandbox, { recursive: true, force: true }));
const originalTools = ["read", "bash", "edit", "write", "codemode"];
const rawRoute = (standard = false) => ({
  intent: "development",
  route: standard ? "STANDARD" : "FAST",
  riskLevel: standard ? "medium" : "low",
  confidence: 1,
  reasons: ["Concrete investigated evidence"],
  signals: {
    crossModule: false,
    architectureChange: false,
    breakingChange: false,
    securitySensitive: standard,
    migrationRequired: false,
    designUncertainty: false,
  },
  assessment: {
    goalClear: true,
    implementationClear: true,
    impactControlled: true,
    lowRisk: !standard,
    verificationClear: true,
    designDecisionRequired: false,
    phasedImplementationRequired: false,
  },
});
const node = (script) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
const command = node(
  'require("node:assert/strict").equal(require("node:fs").readFileSync("value.txt", "utf8"), "after")',
);
const plan = `Change value.txt from before to after. Given the old value, when updated, then it is after. Verify: ${command}`;
const summary =
  "Changed value.txt from before to after; verify the stored value with a file-content assertion.";
const validation = {
  passed: true,
  summary:
    "File-content assertion executed successfully; the stored value satisfies the acceptance criterion.",
};

async function project() {
  const cwd = await mkdtemp(join(sandbox, "project-"));
  await writeFile(join(cwd, "value.txt"), "before");
  return cwd;
}
function harness(cwd, options = {}) {
  const commands = new Map(),
    events = new Map(),
    tools = new Map(),
    shortcuts = new Map();
  const entries = options.entries ?? [],
    messages = [],
    notices = [],
    statuses = [];
  let activeTools = [...originalTools],
    busy = false,
    count = 0,
    confirm = options.confirm ?? false;
  const sessionId = `session-${cwd.split("-").at(-1)}`;
  const abortController = new AbortController();
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
    registerEntryRenderer() {},
    on(name, handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (content) => messages.push(content),
    sendMessage: (message) => messages.push(message.content),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = [...names];
    },
  };
  gkdWorkflow(pi);
  tools.set("bash", createBashToolDefinition(cwd));
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: options.hasUI ?? false,
    signal: abortController.signal,
    model: { id: "test", provider: "test" },
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    isProjectTrusted: () => true,
    abort: () => abortController.abort(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getBranch: () => entries,
    },
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus: (_key, status) => statuses.push(status),
      confirm: async (...args) => (typeof confirm === "function" ? confirm(...args) : confirm),
    },
  };
  async function event(name, data = {}) {
    let result;
    for (const handler of events.get(name) ?? []) {
      const next = await handler(data, ctx);
      if (next !== undefined) {
        result = { ...result, ...next };
        if (next.systemPrompt) data = { ...data, systemPrompt: next.systemPrompt };
        if (next.block || next.action === "handled") break;
      }
    }
    return result;
  }
  async function invoke(name, args) {
    const toolCallId = `call-${++count}`;
    const gate = await event("tool_call", { toolName: name, toolCallId, input: args });
    if (gate?.block) return { blocked: true, ...gate };
    const previous = busy;
    busy = true;
    try {
      return await tools.get(name).execute(toolCallId, args, ctx.signal, undefined, ctx);
    } finally {
      busy = previous;
    }
  }
  function state() {
    const marker = entries.findLast((entry) => entry.customType === "gkd-task");
    return marker?.data.taskId ? loadState(sessionId, marker.data.taskId) : undefined;
  }
  return {
    ctx,
    commands,
    shortcuts,
    entries,
    messages,
    notices,
    statuses,
    event,
    invoke,
    state,
    setBusy: (value) => {
      busy = value;
    },
    activeTools: () => activeTools,
    setConfirm: (value) => {
      confirm = value;
    },
    async start(standard = false) {
      await commands.get("gkd-workloop").handler("Change the stored value to after", ctx);
      assert.equal(messages.at(-1), "/skill:gkd-workloop Change the stored value to after");
      await invoke("gkd_workloop_start", { kind: "development" });
      assert.equal(state().phase, "ROUTING");
      await invoke("gkd_judge_route", { response: JSON.stringify(rawRoute(standard)) });
    },
    report: (action, extra = {}) =>
      invoke("gkd_report", {
        taskId: state().taskId,
        planVersion: state().planVersion,
        action,
        ...extra,
      }),
    input: (text, source = "interactive", extra = {}) => event("input", { text, source, ...extra }),
  };
}

test("loading is inert and only the three existing commands are registered", async () => {
  const app = harness(await project());
  assert.deepEqual([...app.commands.keys()].sort(), ["gkd-judge-route", "gkd-settings", "gkd-workloop"]);
  assert.deepEqual([...app.shortcuts.keys()], ["super+shift+g"]);
  assert.deepEqual(app.activeTools(), originalTools);
  assert.equal(await app.event("tool_call", { toolName: "write", input: {} }), undefined);
  assert.equal(await app.event("before_agent_start", { systemPrompt: "ordinary" }), undefined);
  await app.commands.get("gkd-workloop").handler("", app.ctx);
  assert.equal(app.state(), undefined);
});

test("FAST routes → implements → verifies with normal tools → completes with an Agent report", async () => {
  const cwd = await project(),
    app = harness(cwd);
  await app.start();
  assert.equal(app.state().phase, "IMPLEMENTING");
  await assert.rejects(app.report("verified", validation), /requires VERIFYING/);
  await writeFile(join(cwd, "value.txt"), "after");
  await app.report("implemented", { summary });
  assert.equal(app.state().phase, "VERIFYING");
  assert.match(app.statuses.at(-1), /GKD · FAST · VERIFYING/);
  assert.deepEqual(app.activeTools(), [...originalTools, "gkd_route_evidence", "gkd_report"]);
  const result = await app.invoke("bash", { command });
  assert.equal(result.structuredContent.exit_code, 0);
  await app.report("verified", validation);
  assert.equal(app.state().phase, "COMPLETED");
  assert.deepEqual(app.state().validation, validation);
  assert.equal(app.state().implementation, summary);
  assert.deepEqual(app.activeTools(), originalTools);
  assert.equal(
    (await app.invoke("write", {})).blocked,
    true,
    "the finishing run cannot keep executing",
  );
  await app.event("agent_settled", { aborted: false });
  assert.equal(await app.event("tool_call", { toolName: "write", input: {} }), undefined);
});

test("verification trusts the main Agent's report rather than imposing execution-evidence gates", async () => {
  const app = harness(await project());
  await app.start();
  await app.report("implemented", {
    summary: "Implementation inspected; acceptance needs a manual check.",
  });
  const report = {
    passed: true,
    summary: "User confirmed the required manual behavior in the conversation.",
  };
  await app.report("verified", report);
  assert.equal(app.state().phase, "COMPLETED");
  assert.deepEqual(
    app.state().validation,
    report,
    "the report is recorded, not independently certified",
  );
});

test("STANDARD stays read-only until the user approves the current task and plan", async () => {
  const cwd = await project(),
    app = harness(cwd);
  await app.start(true);
  for (const name of ["write", "edit", "bash", "codemode", "subagent", "unknown"]) {
    assert.equal((await app.event("tool_call", { toolName: name, input: {} })).block, true, name);
  }
  await app.report("plan", { plan });
  assert.equal(app.state().phase, "AWAITING_APPROVAL");
  await app.event("agent_settled", { aborted: false });
  assert.equal(app.state().phase, "AWAITING_APPROVAL", "idle waiting is not an interruption");
  assert.equal(await app.input("批准当前计划", "extension"), undefined);
  for (const text of ["yes", "好", "继续上次任务"]) await app.input(text);
  assert.equal(app.state().phase, "AWAITING_APPROVAL");
  await assert.rejects(app.report("approve"), /permission/);
  await assert.rejects(app.report("implemented", { summary }), /requires IMPLEMENTING/);
  await app.input("批准当前计划");
  assert.equal(app.state().phase, "IMPLEMENTING");
  assert.deepEqual(app.state().approval, { taskId: app.state().taskId, planVersion: 1 });
  await assert.rejects(
    app.invoke("gkd_report", {
      action: "implemented",
      taskId: "old-task",
      planVersion: 1,
      summary,
    }),
    /Stale/,
  );
  await writeFile(join(cwd, "value.txt"), "after");
  await app.report("implemented", { summary });
  await app.invoke("bash", { command });
  await app.report("verified", validation);
  assert.equal(app.state().phase, "COMPLETED");
});

test("native approval is current-plan-bound and a replacement invalidates an old dialog", async () => {
  const app = harness(await project(), { hasUI: true, confirm: true });
  await app.start(true);
  await app.report("plan", { plan });
  assert.equal(app.state().phase, "IMPLEMENTING");
  await app.report("reevaluate", { reason: "The approved scope needs a new design." });
  let resolve;
  app.setConfirm(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const old = app.report("plan", { plan });
  while (!resolve) await new Promise((done) => setImmediate(done));
  app.ctx.hasUI = false;
  await app.report("plan", { plan: plan + " Include another scenario." });
  resolve(true);
  await old;
  assert.equal(app.state().phase, "AWAITING_APPROVAL");
  assert.equal(app.state().approval, null);
  assert.equal((await app.event("tool_call", { toolName: "write", input: {} })).block, true);
  await app.input("批准当前计划");
  assert.equal(app.state().approval.planVersion, 3);
});

test("reported verification failure allows two automatic repairs, then blocks", async () => {
  const app = harness(await project());
  await app.start();
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.report("implemented", { summary });
    await app.report("verified", {
      passed: false,
      summary: "The required behavior still fails its functional check.",
    });
    assert.equal(app.state().phase, attempt < 2 ? "IMPLEMENTING" : "BLOCKED");
    assert.equal(app.state().retries, Math.min(2, attempt + 1));
  }
});

test("a reported failure can be repaired, re-verified and completed", async () => {
  const cwd = await project(),
    app = harness(cwd);
  await app.start();
  await app.report("implemented", { summary });
  assert.notEqual((await app.invoke("bash", { command })).structuredContent.exit_code, 0);
  await app.report("verified", { passed: false, summary: "The file still contains before." });
  await writeFile(join(cwd, "value.txt"), "after");
  await app.report("implemented", { summary });
  assert.equal(app.state().validation, null);
  assert.equal((await app.invoke("bash", { command })).structuredContent.exit_code, 0);
  await app.report("verified", validation);
  assert.equal(app.state().phase, "COMPLETED");
});

test("FAST major-risk reports enter STANDARD planning and require fresh approval", async () => {
  const app = harness(await project());
  await app.start();
  await app.report("reevaluate", { reason: "The change needs a security design decision." });
  assert.equal(app.state().route, "STANDARD");
  assert.equal(app.state().phase, "PLANNING");
  assert.equal((await app.event("tool_call", { toolName: "bash", input: {} })).block, true);
  await app.report("plan", { plan });
  await app.input("批准当前计划");
  assert.equal(app.state().phase, "IMPLEMENTING");
});

test("pause and reload preserve progress; explicit resume restarts work without old approval or validation", async () => {
  for (const standard of [false, true]) {
    const cwd = await project(),
      app = harness(cwd, { hasUI: true, confirm: true });
    await app.start(standard);
    if (standard) await app.report("plan", { plan });
    await app.report("implemented", { summary });
    await app.event("agent_settled", { aborted: true });
    assert.equal(app.state().phase, "PAUSED");
    assert.deepEqual(app.activeTools(), originalTools);
    const restored = harness(cwd, { entries: app.entries });
    await restored.event("session_start");
    await restored.input("继续上次任务");
    assert.equal(restored.state().phase, standard ? "PLANNING" : "IMPLEMENTING");
    assert.equal(restored.state().approval, null);
    assert.equal(restored.state().validation, null);
  }
});

test("only user cancellation ends the task, without undoing code or starting parallel work", async () => {
  const cwd = await project(),
    app = harness(cwd);
  await app.start();
  const taskId = app.state().taskId;
  await app.commands.get("gkd-workloop").handler("Another task", app.ctx);
  assert.equal(app.state().taskId, taskId);
  await writeFile(join(cwd, "value.txt"), "unfinished work");
  await app.input("取消当前任务", "extension");
  assert.equal(app.state().phase, "IMPLEMENTING");
  await app.input("取消当前任务");
  assert.equal(app.state().phase, "CANCELLED");
  assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "unfinished work");
  await app.input("继续上次任务");
  assert.equal(app.state().phase, "CANCELLED");
});

test("NONE/DIRECT exit development control and routing failures block instead of completing", async () => {
  for (const operation of [false, true]) {
    const app = harness(await project());
    await app.commands.get("gkd").handler("ordinary request", app.ctx);
    const raw = rawRoute();
    raw.intent = operation ? "operation" : "non_development";
    raw.route = operation ? "DIRECT" : "NONE";
    if (operation)
      raw.assessment = Object.fromEntries(Object.keys(raw.assessment).map((key) => [key, false]));
    await app.invoke("gkd_judge_route", { response: JSON.stringify(raw) });
    assert.equal(app.state(), undefined);
    assert.deepEqual(app.activeTools(), originalTools);
  }
  const app = harness(await project());
  await app.commands.get("gkd").handler("task", app.ctx);
  await app.invoke("gkd_judge_route", { response: "invalid" });
  assert.equal(app.state().phase, "BLOCKED");
  await app.event("agent_settled");
  await app.input("继续上次任务");
  assert.equal(app.state().phase, "ROUTING");
});

test("global auto mode routes the original input without injecting a duplicate message", async (t) => {
  const path = join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json");
  t.after(() => rm(path, { force: true }));
  const app = harness(await project());
  assert.equal(await app.input("ordinary input"), undefined, "default off");
  await app.shortcuts.get("super+shift+g").handler(app.ctx);
  for (const standard of [false, true]) {
    const current = harness(await project());
    const prompt = "  Change the stored value to after  ";
    assert.equal((await current.input(prompt)).action, "continue");
    assert.equal(current.state().task, prompt.trim());
    assert.equal(current.messages.length, 0, "the current native input is reused");
    const instructions = await current.event("before_agent_start", {
      messageType: "user",
      prompt,
      systemPrompt: "base",
    });
    assert.match(instructions.systemPrompt, /Task Route Policy/);
    const normalized = await current.event("before_agent_start", {
      messageType: "user",
      prompt: `${prompt}\n[Image resized by Pi]`,
      systemPrompt: "base",
    });
    assert.match(
      normalized.systemPrompt,
      /Task Route Policy/,
      "native image preprocessing cannot drop routing instructions",
    );
    assert.deepEqual(current.activeTools(), ["gkd_route_evidence", "gkd_judge_route"]);
    await current.invoke("gkd_judge_route", { response: JSON.stringify(rawRoute(standard)) });
    if (standard) {
      await current.report("plan", { plan });
      assert.equal((await current.invoke("write", {})).blocked, true);
      await current.input("批准当前计划");
    }
    assert.equal(current.state().phase, "IMPLEMENTING");
    await current.report("implemented", { summary });
    await current.report("verified", validation);
    await current.event("agent_settled", { aborted: false });
    assert.equal((await current.input("A new task")).action, "continue");
    assert.equal(current.state().phase, "ROUTING");
  }
  await app.shortcuts.get("super+shift+g").handler(app.ctx);
  const off = harness(await project());
  assert.equal(
    await off.input("ordinary input", "rpc"),
    undefined,
    "other sessions use the global off value",
  );
  await off.start();
  assert.equal(off.state().phase, "IMPLEMENTING", "manual /gkd-workloop still works when off");
});

test("auto mode leaves extension messages, slash commands, streaming and existing tasks alone", async (t) => {
  const path = join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json");
  t.after(() => rm(path, { force: true }));
  saveSettings(path, true, false);
  const app = harness(await project());
  for (const text of ["", "/skill:review", "/template", "!echo hello"])
    assert.equal(await app.input(text), undefined);
  assert.equal(await app.input("injected", "extension"), undefined);
  assert.equal(
    await app.input("queued", "interactive", { streamingBehavior: "followUp" }),
    undefined,
  );
  app.setBusy(true);
  assert.equal(await app.input("steering"), undefined);
  app.setBusy(false);
  assert.equal(app.state(), undefined);
  await app.input("Start task", "rpc");
  await app.invoke("gkd_judge_route", { response: JSON.stringify(rawRoute(true)) });
  await app.report("plan", { plan });
  const taskId = app.state().taskId;
  await app.shortcuts.get("super+shift+g").handler(app.ctx);
  assert.equal(app.state().phase, "AWAITING_APPROVAL", "turning off does not approve or cancel");
  await app.input("Chat about something else");
  assert.equal(app.state().phase, "PAUSED");
  await app.shortcuts.get("super+shift+g").handler(app.ctx);
  await app.input("Another ordinary message");
  assert.equal(
    app.state().phase,
    "PAUSED",
    "turning on does not resume or replace the current task",
  );
  assert.equal(app.state().taskId, taskId);
  await app.input("继续上次任务");
  assert.equal(app.state().phase, "PLANNING");
  await app.input("取消当前任务");
  assert.equal(app.state().phase, "CANCELLED");
});

test("auto NONE/DIRECT exit development control without running a second classification", async (t) => {
  const path = join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json");
  t.after(() => rm(path, { force: true }));
  saveSettings(path, true, false);
  for (const operation of [false, true]) {
    const app = harness(await project());
    await app.input(operation ? "Run existing tests" : "Explain useEffect");
    const raw = rawRoute();
    raw.intent = operation ? "operation" : "non_development";
    raw.route = operation ? "DIRECT" : "NONE";
    if (operation)
      raw.assessment = Object.fromEntries(Object.keys(raw.assessment).map((key) => [key, false]));
    const result = await app.invoke("gkd_judge_route", { response: JSON.stringify(raw) });
    assert.equal(app.state(), undefined);
    assert.equal(result.terminate, false, "ordinary response continues in the same turn");
    assert.deepEqual(app.activeTools(), originalTools);
    assert.equal(app.messages.length, 0);
  }
});

test("auto startup failures consume input instead of silently bypassing GKD", async (t) => {
  const path = join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json");
  t.after(() => rm(path, { force: true }));
  saveSettings(path, true, false);
  for (const kind of ["untrusted", "model", "length", "settings"]) {
    const app = harness(await project());
    if (kind === "untrusted") app.ctx.isProjectTrusted = () => false;
    if (kind === "model") app.ctx.model = undefined;
    if (kind === "settings") await writeFile(path, "{");
    assert.equal(
      (await app.input(kind === "length" ? "x".repeat(16001) : "Task")).action,
      "handled",
      kind,
    );
    assert.equal(app.state(), undefined);
    assert.ok(app.notices.length > 0);
    assert.deepEqual(app.activeTools(), originalTools);
  }
});

test("saved state keeps the core transition, identity and approval invariants", async () => {
  const app = harness(await project());
  await app.start();
  const state = app.state();
  saveState(state);
  assert.deepEqual(loadState(state.sessionId, state.taskId), state);
  assert.throws(() => transition(state, "COMPLETED"), /Illegal/);
  assert.throws(() => transition({ ...state, phase: "CANCELLED" }, "IMPLEMENTING"), /Illegal/);
  assert.throws(
    () => validateState({ ...state, route: "STANDARD", approval: null }),
    /not approved/,
  );
  assert.throws(() => saveState({ ...state, phase: "made-up" }), /Invalid/);
});
