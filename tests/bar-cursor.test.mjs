import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import barCursor from "../extensions/bar-cursor.ts";

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-bar-cursor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
    else delete process.stdout.isTTY;
  });
  const writes = [];
  t.mock.method(process.stdout, "write", (text) => {
    writes.push(text);
    return true;
  });
  const notifications = [];
  const ui = { notify: (message, type) => notifications.push({ message, type }) };
  const handlers = new Map();
  const load = () => {
    handlers.clear();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      barCursor({ on: (event, handler) => handlers.set(event, handler) });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  };
  load();
  return {
    agentDir,
    reload: load,
    writes,
    notifications,
    start: (mode = "tui") => handlers.get("session_start")({}, { mode, ui }),
    shutdown: () => handlers.get("session_shutdown")(),
  };
}

const notice = {
  message: "竖线光标：请在 /settings 中将 Show hardware cursor 设为 true；若已开启，无需操作。",
  type: "info",
};

test("loading is inert; TUI startup sets only the shape and shows one setup notice", async (t) => {
  const cursor = await setup(t);
  assert.deepEqual(cursor.writes, []);
  assert.deepEqual(cursor.notifications, []);
  await assert.rejects(readdir(cursor.agentDir), { code: "ENOENT" });
  cursor.shutdown();
  assert.deepEqual(cursor.writes, []);
  await mkdir(cursor.agentDir);
  const settingsPath = join(cursor.agentDir, "settings.json");
  const settings = '{"showHardwareCursor":false,"other":"keep"}\n';
  await writeFile(settingsPath, settings);
  await cursor.start();
  await cursor.start();
  assert.deepEqual(cursor.writes, ["\x1b[5 q"]);
  assert.deepEqual(cursor.notifications, [notice]);
  assert.deepEqual((await readdir(cursor.agentDir)).sort(), ["bar-cursor-notice-shown", "settings.json"]);
  cursor.shutdown();
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q", "\x1b[0 q"]);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
});

test("non-TUI and non-TTY sessions have no effects and do not consume the notice", async (t) => {
  const cursor = await setup(t);
  for (const mode of ["print", "json", "rpc"]) {
    await cursor.start(mode);
    cursor.shutdown();
  }
  for (const isTTY of [false, undefined]) {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
    await cursor.start();
    cursor.shutdown();
  }
  assert.deepEqual(cursor.writes, []);
  assert.deepEqual(cursor.notifications, []);
  await assert.rejects(readdir(cursor.agentDir), { code: "ENOENT" });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  await cursor.start();
  assert.deepEqual(cursor.notifications, [notice]);
});

test("session replacement and a fresh extension runtime do not repeat the notice", async (t) => {
  const cursor = await setup(t);
  await cursor.start();
  cursor.shutdown();
  await cursor.start();
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q", "\x1b[0 q", "\x1b[5 q", "\x1b[0 q"]);
  assert.deepEqual(cursor.notifications, [notice]);
  cursor.writes.length = 0;
  cursor.notifications.length = 0;
  cursor.reload();
  await cursor.start();
  assert.deepEqual(cursor.writes, ["\x1b[5 q"]);
  assert.deepEqual(cursor.notifications, []);
  cursor.shutdown();
});

test("cleanup does not write escapes if output is no longer a TTY", async (t) => {
  const cursor = await setup(t);
  await cursor.start();
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q"]);
});

test("notice persistence failure warns but still explains setup and preserves cleanup", async (t) => {
  const cursor = await setup(t);
  await writeFile(cursor.agentDir, "not a directory");
  await cursor.start();
  assert.equal(cursor.notifications[0].type, "warning");
  assert.match(cursor.notifications[0].message, /无法记录竖线光标提示状态/);
  assert.deepEqual(cursor.notifications[1], notice);
  assert.equal(await readFile(cursor.agentDir, "utf8"), "not a directory");
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q", "\x1b[0 q"]);
});
