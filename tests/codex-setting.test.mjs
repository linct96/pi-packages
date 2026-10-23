import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import codexSetting from "../extensions/codex-setting/index.ts";
import { createSettingsMenu } from "../extensions/codex-setting/menu.ts";
import { readSettings, saveSettings } from "../extensions/codex-setting/settings.ts";

initTheme("dark", false);
const keybindings = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  "app.models.save": { defaultKeys: "ctrl+s" },
});
setKeybindings(keybindings);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const tui = { requestRender() {} };
const enter = "\r";
const space = " ";
const escape = "\x1b";
const ctrlS = "\x13";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-setting-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function menu(options = {}) {
  return createSettingsMenu(tui, theme, keybindings, {
    fast: false,
    defaultFast: false,
    onApply() {},
    async onSave() {},
    onClose() {},
    ...options,
  });
}

const text = (component) => stripVTControlCharacters(component.render(80).join("\n"));
const settle = () => new Promise(setImmediate);

test("settings default off, save atomically, and preserve other keys", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "agent", "codex-setting.json");
  assert.deepEqual(await readSettings(path), { fast: false });
  await saveSettings(path, true, false, new AbortController().signal);
  assert.deepEqual(await readSettings(path), { fast: true });
  await writeFile(path, JSON.stringify({ fast: true, other: "keep" }));
  await saveSettings(path, false, true, new AbortController().signal);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { fast: false, other: "keep" });
  assert.deepEqual(await readdir(join(directory, "agent")), ["codex-setting.json"]);
});

test("malformed settings are reported and never overwritten", async (t) => {
  const path = join(await temporaryDirectory(t), "codex-setting.json");
  for (const original of ["{", '{"fast":"on"}', "null", "[]"]) {
    await writeFile(path, original);
    await assert.rejects(readSettings(path));
    await assert.rejects(saveSettings(path, true, false, new AbortController().signal));
    assert.equal(await readFile(path, "utf8"), original);
  }
});

test("stale defaults and concurrent writers are rejected without losing settings", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "codex-setting.json");
  const signal = () => new AbortController().signal;
  await writeFile(path, JSON.stringify({ fast: true, other: "keep" }));
  await assert.rejects(saveSettings(path, false, false, signal()), /changed on disk/);
  assert.deepEqual(await readSettings(path), { fast: true, other: "keep" });
  await writeFile(`${path}.lock`, "another writer");
  await assert.rejects(saveSettings(path, false, true, signal()), /locked/);
  assert.equal(await readFile(`${path}.lock`, "utf8"), "another writer");
  await rm(`${path}.lock`);
  const results = await Promise.allSettled([
    saveSettings(path, false, true, signal()),
    saveSettings(path, false, true, signal()),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual(await readSettings(path), { fast: false, other: "keep" });
  assert.deepEqual(await readdir(directory), ["codex-setting.json"]);
});

test("cancelled saves leave the file unchanged and do not create a lock", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "codex-setting.json");
  await writeFile(path, '{"fast":false}');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveSettings(path, true, false, controller.signal), { name: "AbortError" });
  assert.equal(await readFile(path, "utf8"), '{"fast":false}');
  assert.deepEqual(await readdir(directory), ["codex-setting.json"]);
});

test("Space and Enter toggle inline without saving, Esc closes without reverting", () => {
  const applied = [];
  let saves = 0;
  let closes = 0;
  const component = menu({
    onApply: (fast) => applied.push(fast),
    onSave: async () => { saves++; },
    onClose: () => { closes++; },
  });
  assert.match(text(component), /Fast\s+off/);
  assert.match(text(component), /Default: off/);
  component.handleInput(space);
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Fast\s+on/);
  component.handleInput(enter);
  assert.deepEqual(applied, [true, false]);
  assert.match(text(component), /Fast\s+off/);
  component.handleInput(space);
  assert.equal(saves, 0);
  component.handleInput(escape);
  assert.equal(closes, 1);
  component.handleInput(space);
  assert.deepEqual(applied, [true, false, true]);
});

test("Ctrl+S saves the current value without reapplying and prevents changes while saving", async () => {
  const applied = [];
  const saved = [];
  let complete;
  const component = menu({
    onApply: (fast) => applied.push(fast),
    onSave: (fast) => {
      saved.push(fast);
      return new Promise((resolve) => { complete = resolve; });
    },
  });
  component.handleInput(space);
  component.handleInput(ctrlS);
  component.handleInput(ctrlS);
  component.handleInput(space);
  component.handleInput(enter);
  assert.deepEqual(saved, [true]);
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Saving/);
  complete();
  await settle();
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Fast\s+on/);
  assert.match(text(component), /Default: on/);
  assert.match(text(component), /Saved as default/);
  for (const width of [20, 40, 80]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("save failure keeps the applied session value and leaves the default unchanged", async () => {
  const applied = [];
  const component = menu({
    onApply: (fast) => applied.push(fast),
    onSave: async () => { throw new Error("disk unavailable"); },
  });
  component.handleInput(space);
  component.handleInput(ctrlS);
  await settle();
  assert.match(text(component), /Save failed: disk unavailable/);
  assert.match(text(component), /Default: off/);
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Fast\s+on/);
});

test("application failure leaves the current value unchanged and permits retry", () => {
  let fail = true;
  const applied = [];
  const component = menu({
    onApply(fast) {
      if (fail) throw new Error("session unavailable");
      applied.push(fast);
    },
  });
  component.handleInput(space);
  assert.match(text(component), /Application failed: session unavailable/);
  assert.match(text(component), /Fast\s+off/);
  assert.match(text(component), /Default: off/);
  fail = false;
  component.handleInput(space);
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Fast\s+on/);
});

test("saving persists the inline value and subsequent toggles only affect the session", async (t) => {
  const path = join(await temporaryDirectory(t), "codex-setting.json");
  let saved;
  const finished = new Promise((resolve) => { saved = resolve; });
  const applied = [];
  const component = menu({
    onApply: (fast) => applied.push(fast),
    async onSave(fast, signal) {
      await saveSettings(path, fast, false, signal);
      saved();
    },
  });
  component.handleInput(space);
  component.handleInput(ctrlS);
  await finished;
  await settle();
  assert.deepEqual(await readSettings(path), { fast: true });
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Default: on/);
  component.handleInput(space);
  assert.deepEqual(applied, [true, false]);
  assert.match(text(component), /Fast\s+off/);
  assert.match(text(component), /Default: on/);
  assert.deepEqual(await readSettings(path), { fast: true });
});

test("disposing a saving menu aborts it and ignores late results and input", async () => {
  let signal;
  let complete;
  let renders = 0;
  const applied = [];
  const component = createSettingsMenu({ requestRender() { renders++; } }, theme, keybindings, {
    fast: false,
    defaultFast: false,
    onApply: (fast) => applied.push(fast),
    onSave(_fast, currentSignal) {
      signal = currentSignal;
      return new Promise((resolve) => { complete = resolve; });
    },
    onClose() {},
  });
  component.handleInput(space);
  component.handleInput(ctrlS);
  component.dispose();
  component.dispose();
  assert.equal(signal.aborted, true);
  const previousRenders = renders;
  component.handleInput(enter);
  component.handleInput(ctrlS);
  complete();
  await settle();
  assert.deepEqual(applied, [true]);
  assert.equal(renders, previousRenders);
  assert.match(text(component), /Default: off/);
});

test("Esc during saving requests cancellation and retains the applied session value", async () => {
  const applied = [];
  const component = menu({
    onApply: (fast) => applied.push(fast),
    onSave: (_fast, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  component.handleInput(space);
  component.handleInput(ctrlS);
  component.handleInput(escape);
  await settle();
  assert.match(text(component), /Save cancelled/);
  assert.deepEqual(applied, [true]);
  assert.match(text(component), /Fast\s+on/);
  assert.match(text(component), /Default: off/);
  component.handleInput(escape);
});

test("command applies Priority only to the selected Codex model and restores branch state", async (t) => {
  const directory = await temporaryDirectory(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const events = new Map();
  let command;
  let shortcut;
  let component;
  let onMenuOpen;
  let branch = [];
  let sessionId = "test-session";
  let failAppend = false;
  const notices = [];
  const statuses = new Map();
  const statusColors = [];
  codexSetting({
    on: (name, handler) => events.set(name, handler),
    registerCommand(name, options) {
      assert.equal(name, "codex-setting");
      command = options;
    },
    registerShortcut(key, options) {
      assert.equal(key, "super+shift+f");
      shortcut = options;
    },
    appendEntry(customType, data) {
      if (failAppend) throw new Error("cannot write session");
      branch.push({ type: "custom", customType, data });
    },
  });
  const model = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-test" };
  const ctx = {
    mode: "tui",
    model,
    sessionManager: { getBranch: () => branch, getSessionId: () => sessionId },
    ui: {
      theme: {
        fg(color, text) {
          statusColors.push(color);
          return text;
        },
      },
      notify: (...args) => notices.push(args),
      setStatus(key, value) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      custom(factory) {
        return new Promise((resolve) => {
          component = factory(tui, theme, keybindings, resolve);
          onMenuOpen();
        });
      },
    },
  };
  async function openMenu() {
    const mounted = new Promise((resolve) => { onMenuOpen = resolve; });
    const completed = command.handler("", ctx);
    await mounted;
    return { completed };
  }
  const request = events.get("before_provider_request");
  const payload = { model: "gpt-test", input: [], service_tier: "auto" };
  await events.get("session_start")({}, ctx);
  assert.equal(request({ payload }, ctx), undefined);
  assert.equal(statuses.has("codex-setting"), false);
  await openMenu();
  component.handleInput(space);
  assert.deepEqual(request({ payload }, ctx), { ...payload, service_tier: "priority" });
  assert.equal(statuses.get("codex-setting"), "Codex Fast");
  const enabledBranch = [...branch];
  for (const otherModel of [
    { ...model, provider: "anthropic", api: "anthropic-messages" },
    { ...model, provider: "openai", api: "openai-responses" },
    { ...model, provider: "custom-openai" },
    { ...model, api: "openai-responses" },
    undefined,
  ]) {
    ctx.model = otherModel;
    events.get("model_select")({ model: otherModel }, ctx);
    assert.equal(statuses.has("codex-setting"), false);
    assert.equal(request({ payload }, ctx), undefined);
  }
  await events.get("session_start")({}, ctx);
  assert.equal(statuses.has("codex-setting"), false);
  ctx.model = model;
  events.get("model_select")({ model }, ctx);
  assert.equal(statuses.get("codex-setting"), "Codex Fast");
  assert.equal(request({ payload }, ctx).service_tier, "priority");
  assert.deepEqual(branch, enabledBranch);
  assert.equal(payload.service_tier, "auto");
  assert.equal(request({ payload }, { ...ctx, model: { ...model, provider: "openai" } }), undefined);
  assert.equal(request({ payload }, { ...ctx, model: { ...model, api: "openai-responses" } }), undefined);
  assert.equal(request({ payload: { model: "another-model" } }, ctx), undefined);
  assert.equal(request({ payload: null }, ctx), undefined);
  await events.get("session_start")({}, ctx);
  assert.equal(request({ payload }, ctx).service_tier, "priority");
  assert.equal(statuses.get("codex-setting"), "Codex Fast");
  branch = [];
  await events.get("session_tree")({}, ctx);
  assert.equal(request({ payload }, ctx), undefined);
  assert.equal(statuses.has("codex-setting"), false);
  await saveSettings(join(directory, "codex-setting.json"), true, false, new AbortController().signal);
  await events.get("session_start")({}, ctx);
  assert.equal(request({ payload }, ctx).service_tier, "priority");
  assert.equal(statuses.get("codex-setting"), "Codex Fast");
  await openMenu();
  component.handleInput(space);
  assert.equal(statuses.has("codex-setting"), false);
  assert.equal(request({ payload }, ctx), undefined);
  await events.get("session_start")({}, ctx);
  assert.equal(statuses.has("codex-setting"), false);
  ctx.mode = "rpc";
  await command.handler("", ctx);
  assert.match(notices.at(-1)[0], /requires TUI/);
  assert.deepEqual(statusColors, ["dim", "dim", "dim", "dim"]);
  ctx.mode = "tui";
  const originalBranch = [...branch];
  const first = await openMenu();
  const stale = component;
  events.get("model_select")({}, ctx);
  await first.completed;
  stale.handleInput(enter);
  assert.deepEqual(branch, originalBranch);
  const second = await openMenu();
  ctx.model = { ...model, id: "another-model" };
  component.handleInput(space);
  assert.match(text(component), /selected model changed/);
  assert.deepEqual(branch, originalBranch);
  events.get("session_shutdown")({}, ctx);
  await second.completed;
  ctx.model = model;
  const third = await openMenu();
  const previousMenu = component;
  await events.get("session_tree")({}, ctx);
  await third.completed;
  previousMenu.handleInput(enter);
  assert.deepEqual(branch, originalBranch);
  const fourth = await openMenu();
  sessionId = "different-session";
  component.handleInput(space);
  assert.match(text(component), /session or selected model changed/);
  assert.deepEqual(branch, originalBranch);
  sessionId = "test-session";
  failAppend = true;
  component.handleInput(enter);
  assert.match(text(component), /Application failed: cannot write session/);
  assert.equal(request({ payload }, ctx), undefined);
  assert.deepEqual(branch, originalBranch);
  failAppend = false;
  component.handleInput(enter);
  assert.equal(request({ payload }, ctx).service_tier, "priority");
  component.handleInput(escape);
  await fourth.completed;
  await t.test("Cmd+Shift+F toggles session Fast, closes stale menus, and preserves defaults", async () => {
    const opened = await openMenu();
    const staleMenu = component;
    shortcut.handler(ctx);
    await opened.completed;
    assert.deepEqual(branch.at(-1), { type: "custom", customType: "codex-setting", data: { fast: false } });
    assert.equal(request({ payload }, ctx), undefined);
    assert.equal(statuses.has("codex-setting"), false);
    assert.deepEqual(notices.at(-1), ["Codex Fast: off", "info"]);
    const afterToggle = [...branch];
    staleMenu.handleInput(space);
    assert.deepEqual(branch, afterToggle);
    await events.get("session_start")({}, ctx);
    assert.equal(request({ payload }, ctx), undefined);
    assert.deepEqual(await readSettings(join(directory, "codex-setting.json")), { fast: true });
    for (const mode of ["rpc", "print", "json"]) shortcut.handler({ ...ctx, mode });
    assert.deepEqual(branch, afterToggle);
    failAppend = true;
    assert.throws(() => shortcut.handler(ctx), /cannot write session/);
    assert.equal(request({ payload }, ctx), undefined);
    assert.equal(statuses.has("codex-setting"), false);
    assert.deepEqual(branch, afterToggle);
    failAppend = false;
    shortcut.handler(ctx);
    assert.equal(request({ payload }, ctx).service_tier, "priority");
    assert.equal(statuses.get("codex-setting"), "Codex Fast");
    assert.deepEqual(notices.at(-1), ["Codex Fast: on", "info"]);
    await events.get("session_tree")({}, ctx);
    assert.equal(request({ payload }, ctx).service_tier, "priority");
    const reopened = await openMenu();
    assert.match(text(component), /Fast\s+on/);
    assert.match(text(component), /Default: on/);
    component.handleInput(escape);
    await reopened.completed;
    assert.deepEqual(await readSettings(join(directory, "codex-setting.json")), { fast: true });
  });
  branch = [];
  const headlessCtx = {
    ...ctx,
    mode: "print",
    ui: {
      get theme() { throw new Error("Theme not initialized"); },
      setStatus() { assert.fail("Headless sessions must not render status"); },
    },
  };
  await events.get("session_start")({}, headlessCtx);
  assert.equal(request({ payload }, headlessCtx).service_tier, "priority");
});
