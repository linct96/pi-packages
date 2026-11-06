import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  createSettingsMenu,
  readSettings,
  registerSettings,
  saveSettings,
} from "../extensions/gkd-workflow/settings.ts";

initTheme("dark", false);
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
setKeybindings(keybindings);
const theme = { fg: (_color, text) => text, bold: (text) => text };
const tui = { requestRender() {} };
const text = (menu) => stripVTControlCharacters(menu.render(80).join("\n"));
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "gkd-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function harness() {
  const commands = new Map(),
    shortcuts = new Map(),
    events = new Map(),
    notices = [],
    statuses = [];
  let component, done;
  registerSettings({
    registerCommand: (name, value) => commands.set(name, value),
    registerShortcut: (key, value) => shortcuts.set(key, value),
    on: (event, handler) => events.set(event, handler),
  });
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "test" },
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus: (key, value) => statuses.push({ key, value }),
      custom: (factory) =>
        new Promise((resolve) => {
          done = resolve;
          component = factory(tui, theme, keybindings, resolve);
        }),
    },
  };
  return {
    ctx,
    commands,
    shortcuts,
    events,
    notices,
    statuses,
    component: () => component,
    close: () => done(),
  };
}

test("global settings default off, save atomically with private permissions and preserve other keys", async (t) => {
  const root = await directory(t),
    path = join(root, "agent", "gkd-workflow.json");
  assert.deepEqual(readSettings(path), { autoEnabled: false });
  saveSettings(path, true, false);
  assert.deepEqual(readSettings(path), { autoEnabled: true });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, JSON.stringify({ autoEnabled: true, future: "keep" }));
  saveSettings(path, false, true);
  assert.deepEqual(readSettings(path), { autoEnabled: false, future: "keep" });
  assert.deepEqual(await readdir(join(root, "agent")), ["gkd-workflow.json"]);
});

test("invalid settings, stale menu values and another writer never overwrite the configuration", async (t) => {
  const root = await directory(t),
    path = join(root, "gkd-workflow.json");
  for (const original of ["{", "null", "[]", '{"autoEnabled":"on"}']) {
    await writeFile(path, original);
    assert.throws(() => readSettings(path));
    assert.throws(() => saveSettings(path, true, false));
    assert.equal(await readFile(path, "utf8"), original);
  }
  await writeFile(path, '{"autoEnabled":true}');
  assert.throws(() => saveSettings(path, false, false), /changed on disk/);
  await writeFile(`${path}.lock`, "another writer");
  assert.throws(() => saveSettings(path, false, true), /EEXIST/);
  assert.equal(await readFile(`${path}.lock`, "utf8"), "another writer");
  assert.deepEqual(readSettings(path), { autoEnabled: true });
});

test("Space/Enter save inline, Esc closes, and save failures roll back the row", () => {
  const applied = [];
  let fail = false,
    closes = 0;
  const menu = createSettingsMenu(tui, theme, keybindings, {
    autoEnabled: false,
    onApply(value) {
      if (fail) throw new Error("disk unavailable");
      applied.push(value);
    },
    onClose() {
      closes++;
    },
  });
  assert.match(text(menu), /自动启用 GKD\s+off/);
  menu.handleInput(" ");
  assert.deepEqual(applied, [true]);
  assert.match(text(menu), /自动启用 GKD\s+on/);
  assert.match(text(menu), /已保存/);
  fail = true;
  menu.handleInput("\r");
  assert.match(text(menu), /保存失败/);
  assert.match(text(menu), /自动启用 GKD\s+on/);
  fail = false;
  menu.handleInput("\r");
  assert.deepEqual(applied, [true, false]);
  for (const width of [20, 40, 80])
    assert.ok(menu.render(width).every((line) => visibleWidth(line) <= width));
  menu.handleInput("\x1b");
  menu.handleInput(" ");
  assert.equal(closes, 1);
  assert.deepEqual(applied, [true, false]);
});

test("menu and Cmd+Shift+G share the global value across sessions without writing session overrides", async (t) => {
  process.env.PI_CODING_AGENT_DIR = await directory(t);
  const path = join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json");
  const app = harness();
  app.events.get("session_start")({}, app.ctx);
  assert.equal(app.statuses.at(-1).value, undefined);
  const opened = app.commands.get("gkd-settings").handler("", app.ctx);
  app.component().handleInput(" ");
  assert.deepEqual(readSettings(path), { autoEnabled: true });
  assert.equal(app.statuses.at(-1).value, "GKD Auto · on");
  app.component().handleInput("\x1b");
  await opened;
  const next = harness();
  next.events.get("session_start")({}, next.ctx);
  assert.equal(next.statuses.at(-1).value, "GKD Auto · on");
  const reopened = next.commands.get("gkd-settings").handler("", next.ctx);
  assert.match(text(next.component()), /自动启用 GKD\s+on/);
  next.shortcuts.get("super+shift+g").handler(next.ctx);
  await reopened;
  assert.deepEqual(readSettings(path), { autoEnabled: false });
  next.component().handleInput(" ");
  assert.deepEqual(readSettings(path), { autoEnabled: false }, "shortcut invalidates the old menu");
  app.events.get("session_tree")({}, app.ctx);
  assert.equal(
    app.statuses.at(-1).value,
    undefined,
    "tree navigation reads global state, not branch history",
  );
});

test("shutdown disposes settings UI; unsupported modes and failed shortcut saves do not change the value", async (t) => {
  process.env.PI_CODING_AGENT_DIR = await directory(t);
  const path = join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json");
  const app = harness();
  const opened = app.commands.get("gkd-settings").handler("", app.ctx);
  app.events.get("session_shutdown")();
  await opened;
  app.component().handleInput(" ");
  assert.deepEqual(readSettings(path), { autoEnabled: false });
  for (const mode of ["rpc", "print", "json"]) {
    app.ctx.mode = mode;
    await app.commands.get("gkd-settings").handler("", app.ctx);
    app.shortcuts.get("super+shift+g").handler(app.ctx);
    assert.deepEqual(readSettings(path), { autoEnabled: false });
  }
  app.ctx.mode = "tui";
  await writeFile(path, "{");
  app.shortcuts.get("super+shift+g").handler(app.ctx);
  assert.equal(app.notices.at(-1).type, "error");
  assert.equal(await readFile(path, "utf8"), "{");
});
