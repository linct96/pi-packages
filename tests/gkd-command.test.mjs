import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import gkdWorkloop from "../extensions/gkd-workflow/index.ts";

function harness() {
  const commands = new Map(),
    events = new Map(),
    shortcuts = new Map();
  const messages = [],
    notices = [];
  let busy = false,
    pending = false,
    failSend = false;
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
    on(name, handler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage(content, options) {
      if (failSend) throw new Error("send failed");
      messages.push({ content, options });
    },
  };
  // No tools, task persistence or permission APIs: this is only an entry/UI adapter.
  gkdWorkloop(pi);
  const ctx = {
    cwd: "/workspace/project",
    mode: "print",
    isIdle: () => !busy,
    hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => "gkd-command-test" },
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus() {},
    },
  };
  return {
    commands,
    shortcuts,
    messages,
    notices,
    ctx,
    command: (input) => commands.get("gkd-workloop").handler(input, ctx),
    event(name, data) {
      let result;
      for (const handler of events.get(name) ?? []) result = handler(data, ctx) ?? result;
      return result;
    },
    setBusy(value) {
      busy = value;
    },
    setPending(value) {
      pending = value;
    },
    failSend() {
      failSend = true;
    },
  };
}

test("Pi entry is inert, forwards the original request and hides cwd metadata", async () => {
  const app = harness();
  assert.deepEqual([...app.commands.keys()].sort(), ["gkd-settings", "gkd-workloop"]);
  assert.deepEqual([...app.shortcuts.keys()], ["super+shift+g"]);
  assert.deepEqual(app.messages, []);
  await app.command("");
  assert.deepEqual(app.messages, []);
  assert.match(app.notices.at(-1).message, /用法/);
  await app.command("  check-lark --force  ");
  assert.deepEqual(app.messages, [
    {
      message: {
        customType: "gkd-workloop-context",
        content: '\n\n[gkd-workloop 当前会话]\n{"cwd":"/workspace/project"}',
        display: false,
      },
      options: { triggerTurn: false },
    },
    {
      content: "/skill:gkd-workloop check-lark --force",
      options: { expandPromptTemplates: true, deliverAs: "followUp" },
    },
  ]);
});

test("Pi entry rejects busy or queued requests and reports dispatch failure without replay", async () => {
  for (const queued of [false, true]) {
    const app = harness();
    if (queued) app.setPending(true);
    else app.setBusy(true);
    await app.command("fix login");
    assert.equal(app.messages.length, 1);
    assert.match(app.messages[0].message.content, /未开始/);
    assert.equal(app.messages[0].message.display, true);
    assert.deepEqual(app.messages[0].options, { triggerTurn: false });
  }
  const app = harness();
  app.failSend();
  await app.command("fix login");
  assert.equal(app.messages.length, 2);
  assert.equal(app.messages[0].message.display, false);
  assert.match(app.messages[1].message.content, /分发未完成/);
});

test("Pi auto mode loads the same standalone Skill without rewriting user input or controlling tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gkd-auto-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const app = harness();
  const event = { messageType: "user", prompt: "fix login", systemPrompt: "base" };
  assert.equal(app.event("before_agent_start", event), undefined);
  await writeFile(join(root, "gkd-workflow.json"), JSON.stringify({ autoEnabled: true }));
  const skill = await readFile(new URL("../skills/gkd-workloop/SKILL.md", import.meta.url), "utf8");
  const loaded = app.event("before_agent_start", event);
  assert.ok(loaded.systemPrompt.startsWith("base\n\n"));
  assert.ok(loaded.systemPrompt.includes(skill));
  assert.match(loaded.systemPrompt, /location=.*skills\/gkd-workloop\/SKILL\.md/);
  assert.equal(event.prompt, "fix login");
  assert.deepEqual(app.messages, []);
  for (const prompt of [
    "",
    "!ls",
    "/model",
    "/skill:gkd-workloop fix login",
    '<skill name="gkd-workloop">expanded</skill>',
  ])
    assert.equal(app.event("before_agent_start", { ...event, prompt }), undefined);
  assert.equal(
    app.event("before_agent_start", { messageType: "custom", message: {}, systemPrompt: "base" }),
    undefined,
  );
  assert.equal(app.event("tool_call", { toolName: "write", input: {} }), undefined);
  await writeFile(join(root, "gkd-workflow.json"), "invalid");
  assert.equal(app.event("before_agent_start", event), undefined);
  assert.match(app.notices.at(-1).message, /无法自动加载/);
});
