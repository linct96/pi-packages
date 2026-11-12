import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { parseProbeConfig } from "../extensions/codex-settings/model-probe/config.ts";
import { validateAnswer } from "../extensions/codex-settings/model-probe/validator.ts";
import {
  FAILURE_OPTIONS,
  selectFailureAction,
} from "../extensions/codex-settings/model-probe/failure-dialog.ts";
import {
  createModelProbe,
  PROBE_ENTRY,
  HANDOFF_ENTRY,
} from "../extensions/codex-settings/model-probe/index.ts";
import { readSettings, saveSettings } from "../extensions/codex-settings/settings.ts";
import { createSettingsMenu } from "../extensions/codex-settings/menu.ts";

const { fauxProvider, fauxAssistantMessage } = await import(
  new URL(
    "../../pi-ai/dist/providers/faux.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const { getCurrentTools, getCurrentSystemPrompt } = await import(
  new URL("../../pi-ai/dist/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
const config = (questions = [{ id: "one", question: "Question one?", answer: "ＡＢＣ" }]) => ({
  ...parseProbeConfig(undefined),
  enabled: true,
  maxAttempts: 1, // Most cases exercise the manual failure gate without automatic restarts.
  questions,
});
const stateOf = (manager) =>
  manager.getBranch().findLast((e) => e.type === "custom" && e.customType === PROBE_ENTRY)?.data;
const tick = () => new Promise(setImmediate);
const image = {
  type: "image",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  mimeType: "image/png",
};

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "model-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("configuration and local Unicode/whitespace contains validation", () => {
  assert.equal(PROBE_ENTRY, "codex-settings:model-probe");
  assert.equal(HANDOFF_ENTRY, "codex-settings:model-probe-handoff");
  assert.equal(parseProbeConfig(undefined).enabled, false);
  assert.equal(parseProbeConfig(undefined).maxAttempts, 3);
  assert.equal(parseProbeConfig({ enabled: true }).maxAttempts, 3);
  assert.equal(parseProbeConfig({ enabled: true, maxAttempts: 1 }).maxAttempts, 1);
  assert.equal(parseProbeConfig({ enabled: true, maxAttempts: 5 }).maxAttempts, 5);
  assert.deepEqual(parseProbeConfig(undefined).models, ["gpt-6.1-sol"]);
  assert.deepEqual(parseProbeConfig({ enabled: true }).models, ["gpt-6.1-sol"]);
  assert.deepEqual(parseProbeConfig({ enabled: true, models: [] }).models, []);
  assert.deepEqual(
    parseProbeConfig({ enabled: true, models: ["gpt-6.1-sol", " extra-model "] }).models,
    ["gpt-6.1-sol", "extra-model"],
  );
  assert.equal(parseProbeConfig({ enabled: true }).questions[0].answer, "高市早苗");
  assert.equal(
    parseProbeConfig({ enabled: true }).questions[0].question,
    "不要联网直接回复我现在的日本首相是谁？直接回答名字！",
  );
  const q = config().questions[0];
  assert.equal(validateAnswer(q, "Answer: A B\nC.").passed, true);
  assert.equal(validateAnswer(q, "wrong").reason, "answer_mismatch");
  assert.equal(validateAnswer(q, "").reason, "empty_answer");
  for (const value of [
    null,
    [],
    { enabled: 1 },
    ...[null, "3", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((maxAttempts) => ({
      enabled: true,
      maxAttempts,
    })),
    ...[null, "gpt-6.1-sol", {}, [null], [1], [" "]].map((models) => ({ enabled: true, models })),
    { enabled: true, questions: [] },
    { enabled: true, questions: [{ id: "a", question: "?", answer: " " }] },
    { ...config(), questions: [q, q] },
    { ...config(), validation: { mode: "exact", requireAll: true } },
    { ...config(), isolation: { disableTools: false, clearSystemPrompt: true } },
    { ...config(), validation: { mode: "contains", requireAll: false } },
  ])
    assert.throws(() => parseProbeConfig(value), /Invalid modelProbe/);
});

test("whole-file settings conflicts preserve custom questions and unknown fields", async (t) => {
  const path = join(await directory(t), "settings.json");
  const original = {
    fast: false,
    modelProbe: {
      ...config(),
      maxAttempts: 5,
      models: ["gpt-6.1-sol", "extra-model"],
      custom: "keep",
    },
    unknown: { nested: true },
  };
  await writeFile(path, JSON.stringify(original));
  const expectedSettings = await readSettings(path);
  await saveSettings(path, true, false, new AbortController().signal, {
    enabled: false,
    expectedSettings,
  });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    ...original,
    fast: true,
    modelProbe: { ...original.modelProbe, enabled: false },
  });
  await assert.rejects(
    saveSettings(path, false, true, new AbortController().signal, {
      enabled: true,
      expectedSettings,
    }),
    /changed on disk/,
  );
  const latest = await readSettings(path);
  await writeFile(path, JSON.stringify({ ...latest, unknown: "external edit" }));
  await assert.rejects(
    saveSettings(path, false, true, new AbortController().signal, {
      enabled: true,
      expectedSettings: latest,
    }),
    /changed on disk/,
  );
  assert.equal((await readSettings(path)).unknown, "external edit");
});

test("native settings menu toggles Probe independently and saves both values", async () => {
  initTheme("dark", false);
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.models.save": { defaultKeys: "ctrl+s" },
  });
  setKeybindings(keys);
  const changes = [],
    saved = [];
  const menu = createSettingsMenu(
    { requestRender() {} },
    { fg: (_c, s) => s, bold: (s) => s },
    keys,
    {
      fast: false,
      defaultFast: false,
      probeEnabled: false,
      onApply: (v) => changes.push(["fast", v]),
      onProbeApply: (v) => changes.push(["probe", v]),
      onSave: async (...args) => {
        saved.push([args[0], args[2]]);
      },
      onClose() {},
    },
  );
  menu.handleInput("\x1b[B");
  menu.handleInput(" ");
  assert.deepEqual(changes, [["probe", true]]);
  menu.handleInput("\x13");
  await tick();
  assert.deepEqual(saved, [[false, true]]);
  assert.match(stripVTControlCharacters(menu.render(80).join("\n")), /Model Probe\s+on/);
  menu.dispose();
});

async function harness(t, settings = config(), entries = []) {
  const root = await directory(t),
    path = join(root, "codex-settings.json");
  await writeFile(path, JSON.stringify({ fast: false, modelProbe: settings }));
  const events = new Map(),
    commands = new Map(),
    renderers = new Map(),
    statuses = new Map(),
    sends = [],
    notices = [],
    dialogs = [];
  let branch = entries,
    sessionId = "session-a",
    stale = false,
    choiceKey = "\x1b";
  const pi = {
    on(name, fn) {
      events.set(name, fn);
    },
    appendEntry(customType, data) {
      assert.equal(stale, false);
      branch.push({ type: "custom", customType, data: structuredClone(data) });
    },
    sendMessage(message) {
      sends.push({ kind: "question", ...message });
    },
    sendUserMessage(content, options) {
      assert.equal(stale, false);
      sends.push({ kind: "user", content, options });
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerMessageRenderer(name, renderer) {
      renderers.set(name, renderer);
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    thinkingLevel: "high",
    model: { provider: "test", api: "test", id: "gpt-6.1-sol" },
    sessionManager: {
      getBranch: () => {
        assert.equal(stale, false);
        return branch;
      },
      getEntries: () => {
        assert.equal(stale, false);
        return branch;
      },
      getSessionId: () => {
        assert.equal(stale, false);
        return sessionId;
      },
    },
    isIdle: () => true,
    aborts: 0,
    abort() {
      this.aborts++;
    },
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus(key, value) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      notify: (...n) => notices.push(n),
      select: async () => "取消",
      custom(factory) {
        return new Promise((resolve) => {
          const dialog = factory(
            { requestRender() {} },
            ctx.ui.theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          dialogs.push(dialog);
          if (choiceKey !== undefined) dialog.handleInput(choiceKey);
        });
      },
    },
  };
  let probe = createModelProbe(pi, path);
  t.after(() => events.get("session_shutdown")({}, ctx));
  const emit = (name, event = {}) => events.get(name)?.(event, ctx);
  async function startAnswer(text = "ABC", stopReason = "stop", extra = {}) {
    const question = sends.findLast((m) => m.kind === "question");
    const options = {};
    await emit("before_agent_start", {
      messageType: "custom",
      message: question,
      systemPromptOptions: options,
    });
    await emit("message_end", {
      message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...extra },
    });
  }
  await emit("session_start");
  return {
    ctx,
    emit,
    sends,
    notices,
    dialogs,
    path,
    commands,
    renderers,
    statuses,
    startAnswer,
    choose(key) {
      choiceKey = key;
    },
    first: (text = "task", images = []) => emit("input", { text, images, source: "interactive" }),
    get state() {
      return branch.findLast((e) => e.type === "custom" && e.customType === PROBE_ENTRY)?.data;
    },
    get entries() {
      return branch;
    },
    probe,
    pi,
    async reload() {
      await emit("session_shutdown");
      probe = createModelProbe(pi, path);
      await emit("session_start");
    },
    invalidate() {
      stale = true;
    },
    changeId() {
      sessionId = "fork-b";
    },
  };
}

test("Model Probe footer follows its session toggle and restores independently of the selected provider", async (t) => {
  const key = "codex-settings:model-probe";
  const h = await harness(t, { ...config(), enabled: false });
  assert.equal(h.statuses.has(key), false);
  const append = h.pi.appendEntry;
  h.pi.appendEntry = () => {
    throw new Error("cannot save toggle");
  };
  assert.throws(() => h.probe.setEnabled(true, h.ctx), /cannot save toggle/);
  assert.equal(h.statuses.has(key), false);
  h.pi.appendEntry = append;
  h.probe.setEnabled(true, h.ctx);
  assert.equal(h.statuses.get(key), "| Model Probe |");
  h.ctx.model = { provider: "anthropic", api: "anthropic-messages", id: "another-model" };
  await h.emit("model_select");
  assert.equal(h.statuses.get(key), "| Model Probe |");
  await h.reload();
  assert.equal(
    h.statuses.get(key),
    "| Model Probe |",
    "reload restores the session toggle, not the disabled default",
  );
  h.ctx.sessionManager.getBranch = () => [];
  await h.emit("session_tree");
  assert.equal(h.statuses.has(key), false, "an empty branch uses the disabled default");
  assert.equal(h.sends.length, 0, "footer updates do not trigger a probe");

  const on = await harness(t);
  assert.equal(
    on.statuses.get(key),
    "| Model Probe |",
    "the enabled global default is visible before first input",
  );
  on.probe.setEnabled(false, on.ctx);
  assert.equal(on.statuses.has(key), false);
  await on.reload();
  assert.equal(on.statuses.has(key), false, "session disablement survives reload");
  on.ctx.sessionManager.getBranch = () => [];
  await on.emit("session_tree");
  assert.equal(on.statuses.get(key), "| Model Probe |");
  await writeFile(on.path, "{");
  await on.emit("session_start");
  assert.equal(on.statuses.has(key), false, "invalid settings clear a stale enabled indicator");
  for (const mode of ["rpc", "print", "json"]) {
    h.ctx.mode = mode;
    h.ctx.ui.setStatus = () => assert.fail("non-TUI mode must not update the footer");
    h.ctx.ui.theme = undefined;
    await h.emit("session_start");
  }
});

test("ordered multi-question probe, pending image handoff, and at-most-once delivery", async (t) => {
  const h = await harness(
    t,
    config([
      { id: "one", question: "Q1", answer: "yes" },
      { id: "two", question: "Q2", answer: "two" },
    ]),
  );
  assert.equal(h.sends.length, 0, "a new session makes no requests before the first input");
  assert.equal(h.state, undefined);
  assert.deepEqual(await h.first("fix login", [image]), { action: "handled" });
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].customType, "codex-settings:model-probe");
  assert.equal(h.sends[0].content, "Q1");
  await h.emit("input", { text: "do not overwrite", source: "rpc" });
  assert.equal(h.state.pendingMessage.text, "fix login");
  await h.startAnswer("yes");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.state.phase, "TESTING");
  assert.equal(h.sends.at(-1).content, "Q2");
  await h.startAnswer("two");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.state.phase, "DELIVERING");
  assert.deepEqual(h.sends.at(-1).content, [{ type: "text", text: "fix login" }, image]);
  assert.ok(h.notices.some(([s]) => s.includes("回答正确")));
  assert.equal(
    await h.emit("input", { text: "fix login", images: [image], source: "extension" }),
    undefined,
  );
  await h.emit("message_end", {
    message: { role: "user", content: [{ type: "text", text: "fix login" }, image] },
  });
  assert.equal(h.state.phase, "READY");
  assert.equal(h.state.pendingMessage.delivery, "delivered");
  const count = h.sends.length;
  await h.reload();
  assert.equal(h.sends.length, count);
  assert.equal(h.state.phase, "READY");
  assert.equal(await h.emit("input", { text: "normal", source: "interactive" }), undefined);
});

test("TUI probe panel shows a concise status without logs or per-question verdicts", async (t) => {
  const h = await harness(
    t,
    config([
      { id: "one", question: "Q1", answer: "yes" },
      { id: "two", question: "Q2", answer: "two" },
    ]),
  );
  await h.first("task", [image]);
  const question = h.sends[0];
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text };
  const panel = h.renderers.get("codex-settings:model-probe")(question, { outputPad: 1 }, theme);
  const view = (component = panel, width = 80) =>
    stripVTControlCharacters(component.render(width).join("\n"));
  assert.match(view(), /\[codex-settings:model-probe\]/);
  assert.match(view().trimEnd(), /答案：yes\s+检测中\.\.\.$/);
  assert.match(view(), /问题：Q1\s+答案：yes/);
  assert.doesNotMatch(view(), /回答：|暂无有效回答/);
  assert.equal(question.display, true);
  await h.startAnswer("yes");
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.sends.at(-1).display, false, "later questions reuse the first question's panel");
  assert.match(view(), /问题：Q1\s+答案：yes\s+回答：yes/);
  assert.match(view(), /Q2/);
  await h.emit("input", { text: "do not overwrite", source: "interactive" });
  await h.startAnswer("partial answer", "error", { errorMessage: "invalid API key" });
  await h.emit("agent_settled", { aborted: false });
  assert.match(view().trimEnd(), /原因：provider_error: invalid API key\s+检测失败$/);
  assert.match(view(), /partial answer/);
  assert.match(view(), /问题：Q2\s+答案：two\s+回答：partial answer/);
  assert.match(view(), /invalid API key/);
  assert.doesNotMatch(view(), /日志：|判定：|预期：|已有待处理消息|状态：FAILED/);
  assert.ok(
    h.state.logs.some((line) => line.includes("已有待处理消息")),
    "display changes preserve stored diagnostics",
  );
  assert.equal(
    h.notices.length,
    0,
    "mounted panels do not produce duplicate extension notifications",
  );
  assert.match(h.dialogs[0].render(80).join("\n"), /模型检测未通过，请选择后续操作/);
  assert.deepEqual(
    h.sends.map((message) => message.content),
    ["Q1", "Q2"],
    "logs and expected answers are never sent as model messages",
  );
  for (const width of [20, 80]) {
    for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  await h.reload();
  const restored = h.renderers.get("codex-settings:model-probe")(question, { outputPad: 1 }, theme);
  assert.match(view(restored), /invalid API key/);
  assert.match(view(restored).trimEnd(), /检测失败$/);
  assert.doesNotMatch(view(restored), /日志：|判定：|已有待处理消息/);
  assert.equal(h.sends.length, 2, "restoring the panel does not repeat the probe");

  for (const attempt of [1, 2, 3]) {
    const progress = await harness(t, { ...config(), maxAttempts: 3 }, [
      { type: "custom", customType: HANDOFF_ENTRY, data: { attempt } },
    ]);
    const progressPanel = progress.renderers.get("codex-settings:model-probe")(
      progress.sends[0],
      { outputPad: 1 },
      theme,
    );
    const text = view(progressPanel);
    assert.ok(text.trimEnd().endsWith(`第 ${attempt}/3 轮检测中...`));
    assert.doesNotMatch(text, /检测轮次：|回答：|暂无有效回答/);
    assert.equal(text.match(/检测中/g)?.length, 1);
    await progress.startAnswer("");
    await progress.emit("agent_settled", { aborted: false });
    assert.ok(view(progressPanel).trimEnd().endsWith(`第 ${attempt}/3 轮检测失败`));
    assert.doesNotMatch(view(progressPanel), /回答：|暂无有效回答/);
    for (const width of [20, 80]) {
      for (const line of progressPanel.render(width)) assert.ok(visibleWidth(line) <= width);
    }
  }
});

test("TUI completion status distinguishes passed probes from explicit overrides", async (t) => {
  for (const override of [false, true]) {
    const h = await harness(t);
    await h.first("task");
    const panel = h.renderers.get("codex-settings:model-probe")(
      h.sends[0],
      { outputPad: 1 },
      {
        fg: (_color, text) => text,
        bg: (_color, text) => text,
      },
    );
    if (override) h.choose("2");
    await h.startAnswer(override ? "wrong" : "ABC");
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.state.phase, "DELIVERING");
    const status = override ? "检测失败（已选择继续）" : "检测通过";
    assert.ok(stripVTControlCharacters(panel.render(80).join("\n")).trimEnd().endsWith(status));
    await h.emit("input", { text: "task", source: "extension" });
    await h.emit("message_end", { message: { role: "user", content: "task" } });
    assert.equal(h.state.phase, "READY");
    const view = stripVTControlCharacters(panel.render(80).join("\n"));
    assert.ok(view.trimEnd().endsWith(status));
    assert.doesNotMatch(view, /日志：|判定：|状态：READY/);
    if (override) assert.doesNotMatch(view, /检测通过/);
  }
});

test("panel log persistence failure stays visible and cannot dispatch a task", async (t) => {
  const h = await harness(t);
  const append = h.pi.appendEntry;
  h.pi.appendEntry = (type, data) => {
    if (data.logs) throw new Error("cannot write logs");
    append(type, data);
  };
  await h.first("must wait");
  assert.equal(h.sends.length, 0);
  assert.ok(h.notices.some(([text]) => text.includes("无法保存检测状态")));
  assert.equal((await h.emit("tool_call", {})).block, true);
});

test("first-input trigger honors the model allowlist and session toggle and ignores non-user input", async (t) => {
  for (const mode of ["tui", "rpc", "print", "json"]) {
    const skipped = await harness(t, { enabled: true });
    skipped.ctx.mode = mode;
    skipped.ctx.model.id = "gpt-6.1-sol-extra";
    await skipped.emit("model_select");
    assert.equal(await skipped.first("ordinary task", [image]), undefined);
    assert.equal(await skipped.emit("tool_call"), undefined);
    await skipped.emit("before_agent_start", { messageType: "user" });
    assert.equal(skipped.ctx.aborts, 0);
    assert.equal(skipped.sends.length, 0);
    assert.equal(skipped.state, undefined);
    skipped.ctx.model.id = "gpt-6.1-sol";
    await skipped.emit("model_select");
    assert.equal(
      (await skipped.first()).action,
      "handled",
      "switching before first input can probe",
    );
    assert.equal(skipped.sends.length, 1);
  }
  const old = await harness(t);
  old.ctx.model.id = "unlisted";
  await old.emit("model_select");
  old.entries.push({ type: "message", message: { role: "user", content: "already executed" } });
  old.ctx.model.id = "gpt-6.1-sol";
  await old.emit("model_select");
  assert.equal(
    await old.first(),
    undefined,
    "switching after conversation does not retroactively probe",
  );
  assert.equal(old.sends.length, 0);

  const empty = await harness(t, { ...config(), models: [] });
  assert.equal(await empty.first(), undefined);
  assert.equal(await empty.emit("tool_call"), undefined);
  assert.equal(empty.sends.length, 0);

  const switched = await harness(t);
  await switched.first("must not replay", [image]);
  await switched.startAnswer();
  const count = switched.sends.length;
  switched.ctx.model.id = "unlisted";
  switched.ctx.thinkingLevel = "off";
  await switched.emit("thinking_level_select");
  await switched.emit("model_select");
  await switched.emit("agent_settled", { aborted: false });
  for (const event of ["session_start", "session_tree"]) {
    await switched.emit(event);
    assert.equal(await switched.first("new task"), undefined);
    assert.equal(await switched.emit("tool_call"), undefined);
    await switched.emit("before_agent_start", { messageType: "user" });
    assert.equal(switched.ctx.aborts, 0);
    assert.equal(switched.sends.length, count);
    assert.equal(switched.state.pendingMessage.text, "must not replay");
  }
  switched.ctx.model.id = "gpt-6.1-sol";
  await switched.emit("model_select");
  assert.equal(switched.state.phase, "FAILED", "switching back does not bypass a prior gate");
  assert.equal((await switched.emit("tool_call")).block, true);
  assert.equal(switched.sends.length, count);

  const h = await harness(t, {
    ...config(),
    enabled: false,
    models: ["gpt-6.1-sol", "selected-before-first-input"],
  });
  h.probe.setEnabled(true, h.ctx);
  assert.equal(h.sends.length, 0);
  await h.emit("input", { text: "", source: "interactive" });
  await h.emit("input", { text: "injected", source: "extension" });
  assert.equal(h.sends.length, 0);
  h.ctx.model.id = "selected-before-first-input";
  await h.emit("model_select");
  assert.equal((await h.emit("input", { text: "hi", source: "rpc" })).action, "handled");
  assert.equal(h.sends.length, 1);
  assert.equal(h.state.pendingMessage.text, "hi");
  assert.ok(h.state.model.includes("selected-before-first-input"));

  const disabled = await harness(t);
  disabled.probe.setEnabled(false, disabled.ctx);
  assert.equal(await disabled.first("ordinary conversation"), undefined);
  disabled.entries.push({
    type: "message",
    message: { role: "user", content: "ordinary conversation" },
  });
  disabled.probe.setEnabled(true, disabled.ctx);
  assert.equal(await disabled.first("already chatting"), undefined);
  assert.equal(
    disabled.sends.length,
    0,
    "enabling after the first conversation message does not retroactively probe",
  );
});

test("startup watchdog is cleared even when a dispatched round starts synchronously", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(
    t,
    config([
      { id: "one", question: "Q1", answer: "yes" },
      { id: "two", question: "Q2", answer: "two" },
    ]),
  );
  await h.first();
  await h.startAnswer("yes");
  await h.emit("agent_start");
  h.pi.sendMessage = (message) => {
    h.emit("before_agent_start", { messageType: "custom", message, systemPromptOptions: {} });
    h.emit("agent_start");
  };
  await h.emit("agent_settled", { aborted: false });
  t.mock.timers.tick(10001);
  assert.equal(
    h.state.phase,
    "TESTING",
    "a running provider request has no 10-second answer timeout",
  );
  const missing = await harness(t);
  t.mock.timers.tick(10001);
  assert.equal(missing.state, undefined, "waiting for first input has no startup timeout");
  await missing.first();
  t.mock.timers.tick(10001);
  assert.equal(missing.state.phase, "FAILED");
  assert.equal(missing.state.reason, "probe_dispatch_failed");
  assert.equal(missing.sends.length, 1);
});

test("failure offers three actions; cancel keeps the pending input and gate closed", async (t) => {
  const h = await harness(
    t,
    config([
      { id: "one", question: "Q1", answer: "yes" },
      { id: "two", question: "Q2", answer: "two" },
    ]),
  );
  await h.first("task");
  await h.startAnswer("wrong");
  await h.emit("agent_settled", { aborted: false });
  await tick();
  assert.equal(h.state.phase, "FAILED");
  assert.equal(h.dialogs.length, 1);
  const dialog = h.dialogs[0].render(80).join("\n");
  for (const option of FAILURE_OPTIONS) assert.ok(dialog.includes(option));
  assert.match(dialog, /模型检测未通过，请选择后续操作/);
  assert.equal(h.sends.length, 1);
  await h.emit("input", { text: "task", source: "interactive" });
  await h.emit("before_agent_start", {
    messageType: "user",
    prompt: "extension bypass",
    systemPromptOptions: {},
  });
  assert.equal(h.ctx.aborts, 1);
  assert.equal((await h.emit("tool_call", {})).block, true);
  assert.equal(h.state.pendingMessage.text, "task");
  await h.reload();
  assert.equal(h.state.phase, "FAILED");
  assert.equal(h.sends.length, 1);
});

test("dismissed or stale failure choices never dispatch the pending message", async (t) => {
  for (const stale of [false, true]) {
    const h = await harness(t);
    h.choose(undefined);
    await h.first("must wait", [image]);
    await h.startAnswer("wrong");
    const settled = h.emit("agent_settled", { aborted: false });
    if (stale) await h.emit("session_shutdown");
    h.dialogs.at(-1).handleInput(stale ? "2" : "\x1b");
    await settled;
    assert.equal(h.state.phase, "FAILED");
    assert.equal(h.state.pendingMessage.delivery, "pending");
    assert.equal(h.sends.length, 1);
  }
});

test("numbered TUI choices dispatch once and wrap long option labels", async (t) => {
  for (const key of ["1", "2", "3"]) {
    const h = await harness(t);
    h.choose(undefined);
    await h.first("original task", [image]);
    await h.startAnswer("wrong");
    const settled = h.emit("agent_settled", { aborted: false });
    const dialog = h.dialogs.at(-1);
    for (const width of [18, 80]) {
      for (const line of dialog.render(width)) assert.ok(visibleWidth(line) <= width);
      const text = stripVTControlCharacters(dialog.render(width).join("\n")).replace(/\s/g, "");
      for (const label of FAILURE_OPTIONS) assert.ok(text.includes(label));
    }
    dialog.handleInput("12");
    dialog.handleInput("\x1b[50;1:3u");
    dialog.handleInput("\x1b[50;1:2u");
    assert.equal(h.sends.length, 1, "paste, release and repeat cannot accept a choice");
    dialog.handleInput(key);
    await settled;
    if (key === "1") assert.match(h.sends.at(-1).content, /^\/codex-probe-restart /);
    if (key === "2")
      assert.deepEqual(h.sends.at(-1).content, [{ type: "text", text: "original task" }, image]);
    assert.equal(h.sends.length, key === "3" ? 1 : 2);
    dialog.handleInput("2");
    dialog.dispose();
    assert.equal(h.sends.length, key === "3" ? 1 : 2, "a closed dialog cannot select again");
  }
});

test("TUI navigation wraps, follows injected keybindings and cancels on abort", async () => {
  let dialog,
    completed = 0;
  const controller = new AbortController();
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "tui.select.up": { defaultKeys: "k" },
    "tui.select.down": { defaultKeys: "j" },
    "tui.input.newLine": { defaultKeys: "enter" },
    "tui.input.submit": { defaultKeys: "ctrl+enter" },
  });
  const ctx = {
    mode: "tui",
    ui: {
      custom(factory) {
        return new Promise((resolve) => {
          dialog = factory(
            { requestRender() {} },
            { fg: (_color, text) => text },
            keys,
            (choice) => {
              completed++;
              resolve(choice);
            },
          );
        });
      },
    },
  };
  const answer = selectFailureAction(ctx, controller.signal);
  dialog.handleInput("k");
  assert.match(dialog.render(80).join("\n"), /❯ 3\. 取消/);
  dialog.handleInput("j");
  assert.match(dialog.render(80).join("\n"), /❯ 1\./);
  dialog.handleInput("j");
  dialog.handleInput("\r");
  assert.equal(completed, 0, "a remapped newline is not confirmation");
  dialog.handleInput("\x1b[13;5u");
  assert.equal(await answer, FAILURE_OPTIONS[1]);
  controller.abort();
  assert.equal(completed, 1);

  const aborted = new AbortController();
  const cancelled = selectFailureAction(ctx, aborted.signal);
  aborted.abort();
  assert.equal(await cancelled, undefined);
  dialog.handleInput("1");
  assert.equal(completed, 2);
  const disposed = selectFailureAction(ctx, new AbortController().signal);
  dialog.dispose();
  assert.equal(await disposed, undefined);
  assert.equal(
    await selectFailureAction(
      {
        mode: "tui",
        ui: {
          custom() {
            assert.fail("already aborted");
          },
        },
      },
      AbortSignal.abort(),
    ),
    undefined,
  );
});

test("provider error, cancellation, empty answers, interruption and model changes fail closed", async (t) => {
  for (const [text, stopReason, aborted, reason] of [
    ["ABC", "error", false, "provider_error"],
    ["ABC", "aborted", true, "aborted"],
    ["", "stop", false, "empty_answer"],
    ["ABC", "length", false, "incomplete_response"],
  ]) {
    const h = await harness(t, { ...config(), maxAttempts: 3 });
    await h.first();
    await h.startAnswer(text, stopReason);
    await h.emit("agent_settled", { aborted });
    assert.equal(h.state.phase, "FAILED");
    assert.match(h.state.reason, new RegExp(reason));
    assert.equal(
      h.sends.length,
      aborted ? 1 : 2,
      "cancellation must not trigger an automatic retry",
    );
    if (!aborted) assert.match(h.sends.at(-1).content, /^\/codex-probe-restart /);
  }
  const interrupted = await harness(t, { ...config(), maxAttempts: 3 });
  await interrupted.first();
  await interrupted.reload();
  assert.equal(interrupted.state.phase, "FAILED");
  assert.equal(interrupted.state.reason, "probe_interrupted");
  assert.equal(interrupted.sends.length, 1, "reload must not restart an interrupted probe");
  const toolAttempt = await harness(t);
  await toolAttempt.first();
  await toolAttempt.startAnswer("ABC", "toolUse", {
    content: [
      { type: "text", text: "ABC" },
      { type: "toolCall", name: "write", id: "unexpected", arguments: {} },
    ],
  });
  assert.equal((await toolAttempt.emit("tool_call", {})).block, true);
  await toolAttempt.emit("agent_settled", { aborted: false });
  assert.equal(toolAttempt.state.reason, "unexpected_tool_call");
  const switched = await harness(t);
  await switched.first();
  await switched.startAnswer();
  switched.ctx.model.id = "another";
  await switched.emit("model_select");
  await switched.emit("agent_settled", { aborted: false });
  assert.equal(switched.state.phase, "FAILED");
  assert.equal(switched.state.reason, "model_changed");
});

test("tree rewind cannot re-deliver a task already attempted on another branch", async (t) => {
  const h = await harness(t);
  await h.emit("input", { text: "publish once", source: "interactive" });
  await h.startAnswer();
  await h.emit("agent_settled", { aborted: false });
  const checkpoint = h.entries.findIndex((e) => e.data?.phase === "PASSED");
  assert.ok(checkpoint >= 0);
  const verifiedBranch = h.entries.slice(0, checkpoint + 1);
  h.ctx.sessionManager.getBranch = () => verifiedBranch;
  const count = h.sends.length;
  await h.emit("session_tree");
  assert.equal(h.state.phase, "FAILED");
  assert.equal(h.state.reason, "delivery_attempted_on_another_branch");
  assert.equal(h.sends.length, count);
});

test("old conversations, disabled defaults, changed configuration, forks and uncertain delivery", async (t) => {
  const old = await harness(t, config(), [
    { type: "message", message: { role: "user", content: "already executed" } },
  ]);
  assert.equal(old.sends.length, 0);
  assert.equal(await old.emit("input", { text: "next", source: "interactive" }), undefined);
  const disabled = await harness(t, parseProbeConfig(undefined));
  assert.equal(disabled.sends.length, 0);
  disabled.probe.setEnabled(true, disabled.ctx);
  assert.equal(disabled.sends.length, 0, "the menu toggle alone does not start a probe");
  await disabled.reload();
  assert.equal(disabled.sends.length, 0, "reloading a clean session still waits for input");
  assert.equal((await disabled.first("hi")).action, "handled");
  assert.equal(disabled.sends.length, 1, "session-only enablement applies to its first input");
  assert.equal(disabled.state.config.enabled, true);
  assert.equal(disabled.state.pendingMessage.text, "hi");
  for (const attempt of [0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = await harness(t, config(), [
      { type: "custom", customType: HANDOFF_ENTRY, data: { attempt } },
    ]);
    assert.equal(invalid.sends.length, 0, "invalid handoff counters must not dispatch a probe");
    assert.equal((await invalid.emit("tool_call")).block, true);
  }
  for (const selection of [
    null,
    { provider: "missing", id: "model", api: "test", thinkingLevel: "invalid" },
    { provider: "missing", id: "model", api: "test", thinkingLevel: "high" },
  ]) {
    const invalid = await harness(t);
    invalid.ctx.modelRegistry = { find: () => undefined };
    invalid.entries.push({ type: "custom", customType: HANDOFF_ENTRY, data: { selection } });
    await invalid.reload();
    assert.equal(
      invalid.sends.length,
      0,
      "unavailable or invalid selections must never use a fallback",
    );
    assert.equal((await invalid.emit("tool_call")).block, true);
    assert.ok(invalid.notices.some(([text]) => text.includes("无法继承模型或思考级别")));
  }
  const invalidSaved = await harness(t);
  await invalidSaved.first();
  invalidSaved.entries.push({
    type: "custom",
    customType: PROBE_ENTRY,
    data: { ...invalidSaved.state, attempt: 0 },
  });
  await invalidSaved.reload();
  assert.equal(invalidSaved.sends.length, 1, "invalid saved counters must not resume a probe");
  assert.equal((await invalidSaved.emit("tool_call")).block, true);
  assert.equal(
    (await readSettings(disabled.path)).modelProbe.enabled,
    false,
    "no global save is needed",
  );
  const h = await harness(t);
  await h.emit("input", { text: "dangerous task", source: "interactive" });
  await h.startAnswer();
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.state.phase, "DELIVERING");
  const sends = h.sends.length;
  await h.reload();
  assert.equal(h.state.reason, "delivery_uncertain_not_replayed");
  assert.equal(h.sends.length, sends);
  h.changeId();
  await h.emit("session_start");
  assert.equal(h.state.reason, "fork_requires_clean_new_session");
  await writeFile(h.path, "{");
  await h.reload();
  assert.equal((await h.emit("input", { text: "blocked", source: "rpc" })).action, "handled");
});

// Use the actual Pi session runtime, extension runner and provider transform chain, without network access.
async function sdk(
  t,
  {
    probeConfig = config(),
    responses = [],
    gkd = false,
    select,
    onSession,
    manager,
    serialized = false,
    persisted = false,
    replacementSelection,
  } = {},
) {
  const root = await directory(t),
    agentDir = join(root, "agent");
  await mkdir(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  await writeFile(
    join(agentDir, "codex-settings.json"),
    JSON.stringify({ fast: true, modelProbe: probeConfig }),
  );
  if (gkd)
    await writeFile(join(agentDir, "gkd-workflow.json"), JSON.stringify({ autoEnabled: true }));
  const runtimeModel = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "openai-codex",
    tokensPerSecond: 100000,
    models: [
      { id: "gpt-6.1-sol", reasoning: !!replacementSelection },
      ...(replacementSelection ? [{ id: replacementSelection.id, reasoning: true }] : []),
    ],
  });
  if (serialized) {
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" } })).toString("base64url")}.test`;
    runtimeModel.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      apiKey: token,
      baseUrl: "https://model-probe.invalid/backend-api",
      models: [
        {
          ...faux.getModel(),
          id: "probe-model",
          api: "openai-codex-responses",
          reasoning: true,
          baseUrl: "https://model-probe.invalid/backend-api",
        },
      ],
    });
  } else runtimeModel.registerNativeProvider(faux.provider);
  const selectedModel = serialized
    ? runtimeModel.getModel("openai-codex", "probe-model")
    : faux.getModel();
  faux.setResponses(responses);
  const notices = [],
    errors = [],
    requests = [],
    sessions = [];
  const factory = async ({ sessionManager, sessionStartEvent }) => {
    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: false }, transport: "sse" },
      { projectTrusted: true },
    );
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [
        fileURLToPath(new URL("../extensions/codex-settings/index.ts", import.meta.url)),
        ...(gkd
          ? [fileURLToPath(new URL("../extensions/gkd-workflow/index.ts", import.meta.url))]
          : []),
      ],
      extensionFactories: [
        (pi) => {
          pi.on("before_agent_start", () => ({ systemPrompt: "LATE BUSINESS SYSTEM SECRET" }));
          pi.on("before_provider_request", (event) => {
            requests.push(event.payload);
          });
        },
      ],
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const services = {
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime: runtimeModel,
      diagnostics: [],
    };
    const result = await createAgentSession({
      cwd: root,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime: runtimeModel,
      model:
        replacementSelection && sessions.length
          ? faux.getModel(replacementSelection.id)
          : selectedModel,
      thinkingLevel:
        replacementSelection && sessions.length ? replacementSelection.thinkingLevel : "high",
      sessionManager,
      sessionStartEvent,
    });
    sessions.push(result.session);
    return { ...result, services, diagnostics: [] };
  };
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: root,
    agentDir,
    sessionManager:
      manager ??
      (persisted
        ? SessionManager.create(root, join(root, "sessions"))
        : SessionManager.inMemory(root)),
  });
  async function bind(session) {
    onSession?.(session, sessions.length);
    await session.bindExtensions({
      mode: select ? "rpc" : "print",
      commandContextActions: {
        newSession: (options) => runtime.newSession(options),
        switchSession: (path, options) => runtime.switchSession(path, options),
        fork: (id, options) => runtime.fork(id, options),
      },
      uiContext: {
        notify: (...args) => notices.push(args),
        setStatus() {},
        theme: { fg: (_c, s) => s },
        select: select ?? (async () => undefined),
        confirm: async () => false,
      },
      onError: (error) => errors.push(error),
    });
  }
  runtime.setRebindSession(bind);
  // Subscribe before the first input; confirmed retries may replace this session.
  const started = new Promise((resolve) => {
    const off = runtime.session.subscribe((e) => {
      if (e.type === "agent_start") {
        queueMicrotask(off);
        resolve();
      }
    });
  });
  await bind(runtime.session);
  t.after(() => runtime.dispose());
  return {
    runtime,
    faux,
    notices,
    errors,
    requests,
    sessions,
    root,
    agentDir,
    async first(text = "hi", images = []) {
      await runtime.session.prompt(text, { images });
      await started;
      await runtime.session.waitForIdle();
    },
  };
}

test(
  "real Pi requests isolate system/tools and restore normal environment with GKD loaded",
  { timeout: 20000 },
  async (t) => {
    let h;
    h = await sdk(t, {
      probeConfig: config([
        { id: "one", question: "Q1", answer: "yes" },
        { id: "two", question: "Q2", answer: "two" },
      ]),
      gkd: true,
      responses: [
        (context) => {
          assert.equal(getCurrentSystemPrompt(context.messages), "");
          assert.deepEqual(getCurrentTools(context.messages), []);
          assert.deepEqual(
            context.messages.filter((m) => m.role !== "system").map((m) => m.content),
            [[{ type: "text", text: "Q1" }]],
          );
          return fauxAssistantMessage("yes");
        },
        (context) => {
          assert.equal(getCurrentSystemPrompt(context.messages), "");
          assert.deepEqual(getCurrentTools(context.messages), []);
          assert.deepEqual(
            context.messages.filter((m) => m.role !== "system").map((m) => m.content),
            [[{ type: "text", text: "Q2" }]],
          );
          return fauxAssistantMessage("two");
        },
        (context) => {
          assert.match(getCurrentSystemPrompt(context.messages), /LATE BUSINESS SYSTEM SECRET/);
          assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "write"));
          return fauxAssistantMessage("normal answer");
        },
      ],
    });
    assert.equal(h.faux.state.callCount, 0);
    assert.equal(stateOf(h.runtime.session.sessionManager), undefined);
    await h.first("normal task");
    assert.equal(
      stateOf(h.runtime.session.sessionManager).phase,
      "READY",
      JSON.stringify(h.errors),
    );
    assert.equal(h.faux.state.callCount, 3);
    assert.deepEqual(h.errors, []);
    assert.ok(h.notices.some(([s]) => s.includes("回答正确")));
    assert.equal(stateOf(h.runtime.session.sessionManager).pendingMessage.text, "normal task");
    assert.equal(stateOf(h.runtime.session.sessionManager).pendingMessage.delivery, "delivered");
    h.faux.setResponses([fauxAssistantMessage("next answer")]);
    await h.runtime.session.sendUserMessage("next task");
    assert.equal(h.faux.state.callCount, 4);
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "READY");
    assert.ok(h.runtime.session.getActiveToolNames().includes("write"));

    const unlisted = await sdk(t, {
      probeConfig: { ...config(), models: ["another-model-id"] },
      responses: [
        (context) => {
          assert.match(getCurrentSystemPrompt(context.messages), /LATE BUSINESS SYSTEM SECRET/);
          assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "write"));
          assert.deepEqual(context.messages.filter((m) => m.role === "user").at(-1).content, [
            { type: "text", text: "ordinary task" },
            image,
          ]);
          return fauxAssistantMessage("no probe needed");
        },
      ],
    });
    await unlisted.first("ordinary task", [image]);
    assert.equal(unlisted.faux.state.callCount, 1);
    assert.equal(stateOf(unlisted.runtime.session.sessionManager), undefined);
    assert.deepEqual(unlisted.errors, []);
  },
);

test(
  "real Pi retries reset manual budgets, inherit model/thinking and deliver the image task once",
  { timeout: 20000 },
  async (t) => {
    for (const [maxAttempts, failures, expectedConfirmations] of [
      [undefined, 2, 0],
      [4, 3, 0],
      [2, 3, 1],
      [2, 4, 2],
      [1, 2, 2],
    ]) {
      const answers = Array(expectedConfirmations).fill("重新创建会话并发送消息");
      let confirmations = 0,
        delivery = 0;
      let resolveDelivered;
      const delivered = new Promise((resolve) => {
        resolveDelivered = resolve;
      });
      const manager = SessionManager.inMemory(await directory(t));
      manager.appendCustomEntry(`${PROBE_ENTRY}:setting`, { enabled: true });
      const h = await sdk(t, {
        manager,
        probeConfig: { ...config(), enabled: false, maxAttempts },
        replacementSelection: { id: "fallback-model", thinkingLevel: "low" },
        select: async () => {
          confirmations++;
          return answers.shift() ?? "取消";
        },
        onSession(session, n) {
          if (n === failures + 1)
            session.subscribe((event) => {
              if (
                event.type === "agent_settled" &&
                stateOf(session.sessionManager)?.pendingMessage?.delivery === "delivered"
              )
                resolveDelivered();
            });
        },
        responses: [
          ...Array.from({ length: failures }, () => fauxAssistantMessage("wrong")),
          fauxAssistantMessage("ABC"),
          (context) => {
            delivery++;
            assert.match(getCurrentSystemPrompt(context.messages), /LATE BUSINESS SYSTEM SECRET/);
            const last = context.messages.filter((m) => m.role === "user").at(-1);
            assert.deepEqual(last.content, [{ type: "text", text: "fix login" }, image]);
            return fauxAssistantMessage("fixed");
          },
        ],
      });
      assert.equal(h.faux.state.callCount, 0);
      await h.runtime.session.prompt("fix login", { images: [image] });
      await delivered;
      await h.runtime.session.waitForIdle();
      assert.equal(
        h.sessions.length,
        failures + 1,
        JSON.stringify({ errors: h.errors, notices: h.notices, confirmations }),
      );
      assert.equal(confirmations, expectedConfirmations);
      assert.equal(
        delivery,
        1,
        JSON.stringify({
          notices: h.notices,
          errors: h.errors,
          states: h.sessions.map((s) => stateOf(s.sessionManager)),
        }),
      );
      assert.equal(stateOf(h.runtime.session.sessionManager).phase, "READY");
      assert.equal(stateOf(h.runtime.session.sessionManager).pendingMessage.delivery, "delivered");
      assert.ok(
        h.runtime.session.sessionManager.getBranch().some((e) => e.customType === HANDOFF_ENTRY),
      );
      assert.deepEqual(h.errors, []);
      await h.runtime.session.reload();
      await h.runtime.session.waitForIdle();
      assert.equal(delivery, 1);
      assert.equal(h.faux.state.callCount, failures + 2);
      assert.equal(stateOf(h.sessions[0].sessionManager).pendingMessage.delivery, "transferred");
      assert.equal(stateOf(h.sessions[1].sessionManager).pendingMessage.delivery, "transferred");
      for (const [index, session] of h.sessions.entries()) {
        const state = stateOf(session.sessionManager);
        assert.equal(
          state.attempt ?? 1,
          (index % (maxAttempts ?? 3)) + 1,
          "automatic retries increment; each confirmed restart resets the full budget",
        );
        assert.equal(state.results.length, 1, "every replacement session is probed again");
        assert.equal(session.model.provider, "openai-codex");
        assert.equal(
          session.model.id,
          "gpt-6.1-sol",
          "never probe or deliver on the fallback model",
        );
        assert.equal(
          session.thinkingLevel,
          "high",
          "inherit the session value, not the new default",
        );
        assert.equal(
          state.model,
          JSON.stringify(["openai-codex", "gpt-6.1-sol", session.model.api, "high"]),
        );
        assert.equal(state.pendingMessage.text, "fix login");
        assert.equal(
          state.config.enabled,
          true,
          "session-only enablement survives confirmed retries",
        );
      }
      for (const session of h.sessions.slice(0, -1)) {
        assert.equal(
          session.sessionManager
            .getBranch()
            .some((e) => e.type === "message" && e.message.role === "user"),
          false,
          "the original task is not run in a failed session",
        );
      }
    }
  },
);

test(
  "real Pi explicit continue keeps the failed result and sends the image task once in the current session",
  { timeout: 20000 },
  async (t) => {
    let selections = 0,
      deliveries = 0;
    let resolveDelivered;
    const delivered = new Promise((resolve) => {
      resolveDelivered = resolve;
    });
    const h = await sdk(t, {
      persisted: true,
      select: async (title, options) => {
        selections++;
        assert.deepEqual(options, ["重新创建会话并发送消息", "继续当前会话并发送消息", "取消"]);
        assert.equal(title, "模型检测未通过，请选择后续操作");
        return options[1];
      },
      onSession(session) {
        session.subscribe((event) => {
          if (
            event.type === "agent_settled" &&
            stateOf(session.sessionManager)?.pendingMessage?.delivery === "delivered"
          )
            resolveDelivered();
        });
      },
      responses: [
        fauxAssistantMessage("wrong"),
        (context) => {
          deliveries++;
          assert.match(getCurrentSystemPrompt(context.messages), /LATE BUSINESS SYSTEM SECRET/);
          assert.ok(getCurrentTools(context.messages).some((tool) => tool.name === "write"));
          assert.deepEqual(context.messages.filter((m) => m.role === "user").at(-1).content, [
            { type: "text", text: "fix login" },
            image,
          ]);
          return fauxAssistantMessage("fixed");
        },
      ],
    });
    const sessionId = h.runtime.session.sessionManager.getSessionId();
    await h.runtime.session.prompt("fix login", { images: [image] });
    await delivered;
    await h.runtime.session.waitForIdle();
    assert.equal(selections, 1);
    assert.equal(deliveries, 1);
    assert.equal(h.sessions.length, 1, "continue does not replace the session");
    const manager = h.runtime.session.sessionManager;
    const state = stateOf(manager);
    assert.equal(manager.getSessionId(), sessionId);
    assert.equal(state.phase, "READY");
    assert.equal(state.reason, "user_override");
    assert.equal(state.results[0].passed, false, "explicit override is not a passed probe");
    assert.equal(state.pendingMessage.delivery, "delivered");
    assert.equal(
      manager
        .getBranch()
        .some(
          (e) => e.type === "custom" && e.customType === PROBE_ENTRY && e.data.phase === "PASSED",
        ),
      false,
    );
    const file = h.runtime.session.sessionFile;
    await h.runtime.session.reload();
    await h.runtime.switchSession(file);
    await h.runtime.session.waitForIdle();
    assert.equal(stateOf(h.runtime.session.sessionManager).reason, "user_override");
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "READY");
    assert.equal(h.faux.state.callCount, 2, "reload/resume neither retests nor resends");
    h.faux.setResponses([fauxAssistantMessage("next answer")]);
    await h.runtime.session.sendUserMessage("next task");
    assert.equal(h.faux.state.callCount, 3, "later messages use the normal environment");
    assert.deepEqual(h.errors, []);
  },
);

test(
  "real persisted sessions restore PASS, reject unverified tree nodes and require a clean session after fork",
  { timeout: 20000 },
  async (t) => {
    const h = await sdk(t, {
      persisted: true,
      responses: [fauxAssistantMessage("ABC"), fauxAssistantMessage("hello")],
    });
    await h.first();
    const original = h.runtime.session.sessionFile;
    assert.ok(original);
    assert.match(await readFile(original, "utf8"), /codex-settings:model-probe/);
    await h.runtime.switchSession(original);
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "READY");
    assert.equal(h.faux.state.callCount, 2);
    const verified = h.runtime.session.sessionManager.getLeafId();
    await h.runtime.fork(verified, { position: "at" });
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "FAILED");
    assert.equal(
      stateOf(h.runtime.session.sessionManager).reason,
      "fork_requires_clean_new_session",
    );
    await h.runtime.switchSession(original);
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "READY");
    const unverified = h.runtime.session.sessionManager
      .getBranch()
      .find(
        (e) => e.type === "custom" && e.customType === PROBE_ENTRY && e.data.phase === "PENDING",
      );
    await h.runtime.session.navigateTree(unverified.id, { summarize: false });
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "FAILED");
    assert.equal(h.faux.state.callCount, 2);
    assert.deepEqual(h.errors, []);
    let resolveFresh;
    const fresh = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    h.runtime.setRebindSession(async (session) => {
      session.subscribe((event) => {
        if (
          event.type === "agent_settled" &&
          stateOf(session.sessionManager)?.pendingMessage?.delivery === "delivered"
        )
          resolveFresh();
      });
      await session.bindExtensions({ mode: "print", onError: (error) => h.errors.push(error) });
    });
    await writeFile(
      join(h.agentDir, "codex-settings.json"),
      JSON.stringify({
        fast: true,
        modelProbe: config([
          { id: "new", question: "Updated question?", answer: "updated answer" },
        ]),
      }),
    );
    h.faux.setResponses([
      (context) => {
        assert.deepEqual(
          context.messages.filter((m) => m.role === "user").map((m) => m.content),
          [[{ type: "text", text: "Updated question?" }]],
        );
        return fauxAssistantMessage("updated answer");
      },
      fauxAssistantMessage("new task done"),
    ]);
    await h.runtime.newSession();
    assert.equal(h.faux.state.callCount, 2, "ordinary /new waits for the first message");
    assert.equal(stateOf(h.runtime.session.sessionManager), undefined);
    await h.runtime.session.prompt("new task");
    await fresh;
    await h.runtime.session.waitForIdle();
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "READY");
    assert.equal(h.faux.state.callCount, 4);
  },
);

test(
  "real Codex serializer sends empty instructions/no tools with selected model, thinking and Priority",
  { timeout: 20000 },
  async (t) => {
    const originalFetch = globalThis.fetch;
    const wire = [];
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /^https:\/\/model-probe\.invalid\//, "no external requests");
      const headers = new Headers(options.headers);
      const raw =
        headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(options.body)
          : options.body;
      const body = JSON.parse(
        Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : raw,
      );
      wire.push(body);
      const text = wire.length === 1 ? "ABC" : "normal answer";
      const item = {
        id: `message-${wire.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
      const events = [
        {
          type: "response.created",
          response: { id: `response-${wire.length}`, status: "in_progress" },
        },
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `response-${wire.length}`,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const h = await sdk(t, {
      serialized: true,
      probeConfig: { ...config(), models: ["probe-model"] },
    });
    assert.equal(wire.length, 0);
    await h.first("normal");
    assert.equal(
      stateOf(h.runtime.session.sessionManager).phase,
      "READY",
      JSON.stringify({ notices: h.notices, errors: h.errors }),
    );
    assert.equal(wire.length, 2);
    assert.equal(wire[0].instructions, "");
    assert.deepEqual(wire[0].tools ?? [], []);
    assert.equal(wire[0].model, "probe-model");
    assert.equal(wire[0].reasoning.effort, "high");
    assert.equal(wire[0].service_tier, "priority");
    assert.equal(wire[0].input.length, 1);
    assert.equal(wire[0].input[0].content[0].text, "Question one?");
    assert.ok(!JSON.stringify(wire[0]).includes("ＡＢＣ"));
    assert.ok(!JSON.stringify(wire[0]).includes("LATE BUSINESS"));
    assert.match(wire[1].instructions, /LATE BUSINESS SYSTEM SECRET/);
    assert.ok(wire[1].tools.some((tool) => tool.name === "write"));
    assert.equal(wire[1].service_tier, "priority");
    assert.deepEqual(h.errors, []);
  },
);

test(
  "real Pi cancellation/no-UI failure cannot run normal input or /gkd bypass",
  { timeout: 20000 },
  async (t) => {
    let resolveFailed;
    const failed = new Promise((resolve) => {
      resolveFailed = resolve;
    });
    const h = await sdk(t, {
      gkd: true,
      persisted: true,
      probeConfig: { ...config(), maxAttempts: 3 },
      responses: Array.from({ length: 3 }, () => fauxAssistantMessage("wrong")),
      onSession(session, n) {
        if (n === 3)
          session.subscribe((event) => {
            if (event.type === "agent_settled") resolveFailed();
          });
      },
    });
    await h.runtime.session.prompt("normal must wait");
    await failed;
    await h.runtime.session.waitForIdle();
    assert.equal(h.sessions.length, 3);
    assert.equal(stateOf(h.runtime.session.sessionManager).attempt, 3);
    assert.equal(stateOf(h.runtime.session.sessionManager).phase, "FAILED");
    await h.runtime.session.prompt("do not overwrite");
    await h.runtime.session.prompt("/gkd-workloop change value.txt");
    await tick();
    await h.runtime.session.waitForIdle();
    assert.equal(h.faux.state.callCount, 3);
    assert.equal(stateOf(h.runtime.session.sessionManager).pendingMessage.text, "normal must wait");
    const file = h.runtime.session.sessionFile;
    await h.runtime.session.reload();
    await h.runtime.switchSession(file);
    await h.runtime.session.waitForIdle();
    assert.equal(
      h.faux.state.callCount,
      3,
      "reload/resume must not reset the exhausted retry budget",
    );
    assert.equal(stateOf(h.runtime.session.sessionManager).attempt, 3);
    assert.deepEqual(h.errors, []);
  },
);
test(
  "first /gkd-workloop command is held by Model Probe and replayed once after success",
  { timeout: 20000 },
  async (t) => {
    const h = await sdk(t, {
      gkd: true,
      persisted: true,
      responses: [fauxAssistantMessage("ABC"), fauxAssistantMessage("check reported")],
    });
    await h.runtime.session.prompt("/gkd-workloop check-lark");
    await h.runtime.session.waitForIdle();
    const state = stateOf(h.runtime.session.sessionManager);
    assert.equal(state.phase, "READY", JSON.stringify(h.errors));
    assert.equal(state.pendingMessage.text, "/gkd-workloop check-lark");
    assert.equal(state.pendingMessage.delivery, "delivered");
    assert.equal(h.faux.state.callCount, 2, "one probe turn and one resumed request");
    assert.deepEqual(h.errors, []);
  },
);
