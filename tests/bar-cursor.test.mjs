import assert from "node:assert/strict";
import test from "node:test";
import { Container, CURSOR_MARKER, renderFakeCursor, TuiAltScreen, TuiMainScreen, VStack } from "@earendil-works/pi-tui";
import barCursor from "../extensions/bar-cursor.ts";

function setup(t, isTTY = true, showHardwareCursor = false, Renderer = TuiMainScreen) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdout, "isTTY", descriptor);
    else delete process.stdout.isTTY;
  });
  const writes = [];
  t.mock.method(process.stdout, "write", (text) => {
    writes.push(text);
    return true;
  });
  const widgets = new Map();
  const hardwareCursorChanges = [];
  const tui = new Renderer({ hideCursor() {} }, showHardwareCursor);
  t.mock.method(tui, "requestRender", () => {});
  const setShowHardwareCursor = tui.setShowHardwareCursor.bind(tui);
  t.mock.method(tui, "setShowHardwareCursor", (enabled) => {
    hardwareCursorChanges.push(enabled);
    setShowHardwareCursor(enabled);
  });
  const widgetContainer = new Container();
  const editor = { render: () => [`输入${CURSOR_MARKER}${renderFakeCursor(" ")}`], invalidate() {} };
  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(new VStack([widgetContainer, editor]));
  } else {
    tui.addChild(widgetContainer);
    tui.addChild(editor);
  }
  const ui = {
    setWidget(key, content) {
      if (content === undefined) widgets.delete(key);
      else widgets.set(key, content(tui));
      widgetContainer.clear();
      for (const component of widgets.values()) widgetContainer.addChild(component);
    },
  };
  const handlers = new Map();
  barCursor({ on: (event, handler) => handlers.set(event, handler) });
  return {
    writes,
    widgets,
    hardwareCursorChanges,
    applySavedSettings: (enabled) => tui.setShowHardwareCursor(enabled),
    render: () => tui.resolveFakeCursors(tui.render(80)),
    get showHardwareCursor() {
      return tui.getShowHardwareCursor();
    },
    start: (mode = "tui") => handlers.get("session_start")({}, { mode, ui }),
    shutdown: () => handlers.get("session_shutdown")(),
  };
}

test("loading is inert; TUI startup sets a blinking bar and shutdown resets once", (t) => {
  const cursor = setup(t);
  assert.deepEqual(cursor.writes, []);
  assert.deepEqual(cursor.hardwareCursorChanges, []);
  cursor.shutdown();
  assert.deepEqual(cursor.writes, []);
  cursor.start();
  cursor.start();
  assert.deepEqual(cursor.writes, ["\x1b[5 q"]);
  assert.equal(cursor.showHardwareCursor, true);
  assert.deepEqual(cursor.hardwareCursorChanges, [true]);
  assert.equal(cursor.widgets.size, 1);
  assert.deepEqual(cursor.render(), [`输入${CURSOR_MARKER} `]);
  assert.deepEqual(cursor.hardwareCursorChanges, [true]);
  cursor.shutdown();
  assert.equal(cursor.widgets.size, 0);
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q", "\x1b[0 q"]);
  assert.equal(cursor.showHardwareCursor, false);
  assert.deepEqual(cursor.hardwareCursorChanges, [true, false]);
});

test("an already enabled hardware cursor stays enabled after cleanup", (t) => {
  const cursor = setup(t, true, true);
  cursor.start();
  assert.equal(cursor.showHardwareCursor, true);
  cursor.shutdown();
  assert.equal(cursor.showHardwareCursor, true);
  assert.deepEqual(cursor.hardwareCursorChanges, [true, true]);
});

test("non-TUI sessions never write terminal escapes, even with a TTY", (t) => {
  const cursor = setup(t);
  for (const mode of ["print", "json", "rpc"]) {
    cursor.start(mode);
    cursor.shutdown();
  }
  assert.deepEqual(cursor.writes, []);
  assert.deepEqual(cursor.hardwareCursorChanges, []);
});

for (const isTTY of [false, undefined]) {
  test(`redirected output is untouched when isTTY is ${isTTY}`, (t) => {
    const cursor = setup(t, false);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
    cursor.start();
    cursor.shutdown();
    assert.deepEqual(cursor.writes, []);
    assert.deepEqual(cursor.hardwareCursorChanges, []);
  });
}

test("session replacement or reload can apply the bar again after cleanup", (t) => {
  const cursor = setup(t);
  cursor.start();
  cursor.shutdown();
  cursor.start();
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q", "\x1b[0 q", "\x1b[5 q", "\x1b[0 q"]);
  assert.deepEqual(cursor.hardwareCursorChanges, [true, false, true, false]);
});

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`/reload survives saved-setting backfill with ${Renderer.name}`, (t) => {
    const cursor = setup(t, true, false, Renderer);
    cursor.start();
    cursor.shutdown();
    cursor.start();
    // The host reapplies showHardwareCursor=false AFTER the replacement's session_start.
    cursor.applySavedSettings(false);
    assert.equal(cursor.showHardwareCursor, false);
    assert.deepEqual(cursor.render(), [`输入${CURSOR_MARKER} `]);
    assert.equal(cursor.showHardwareCursor, true);
    assert.deepEqual(cursor.hardwareCursorChanges, [true, false, true, false, true]);
    for (let i = 0; i < 3; i++) cursor.render();
    assert.deepEqual(cursor.hardwareCursorChanges, [true, false, true, false, true]);
    const staleWidget = cursor.widgets.get("bar-cursor");
    cursor.shutdown();
    assert.equal(cursor.widgets.size, 0);
    assert.equal(cursor.showHardwareCursor, false);
    cursor.start();
    cursor.applySavedSettings(false);
    assert.deepEqual(staleWidget.render(80), []);
    assert.equal(cursor.showHardwareCursor, false);
    cursor.render();
    assert.equal(cursor.showHardwareCursor, true);
    cursor.shutdown();
  });
}

test("cleanup does not write escapes if output is no longer a TTY", (t) => {
  const cursor = setup(t);
  cursor.start();
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  cursor.shutdown();
  assert.deepEqual(cursor.writes, ["\x1b[5 q"]);
  assert.equal(cursor.showHardwareCursor, false);
});
