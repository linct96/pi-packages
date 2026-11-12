import assert from "node:assert/strict";
import { join, parse, sep } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerStatus from "../extensions/footer-status/index.ts";
import { createFooterStatus, formatResponseStats } from "../extensions/footer-status/footer.ts";

const strip = stripVTControlCharacters;
const usage = (input = 1000) => ({
  input,
  output: 200,
  cacheRead: 3000,
  cacheWrite: 0,
  totalTokens: input + 3200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
});

function setup() {
  const handlers = new Map();
  const renderers = new Map();
  let thinking = "high";
  let settings = {};
  let auth = true;
  let contextUsage = { percent: 8, contextWindow: 200000 };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    getThinkingLevel: () => thinking,
    getSettings: () => settings,
    appendEntry: (type, data) => sessionManager.appendCustomEntry(type, data),
  };
  const sessionManager = SessionManager.inMemory(join(process.env.HOME, "project"));
  sessionManager.appendSessionInfo("My session");
  const ctx = {
    mode: "tui",
    sessionManager,
    model: { provider: "openai-codex", id: "gpt-6.1-sol", reasoning: true, contextWindow: 200000 },
    modelRegistry: { isUsingOAuth: () => auth },
    getContextUsage: () => contextUsage,
  };
  const statuses = new Map();
  let branch = "main";
  let callback;
  let renders = 0;
  let disposals = 0;
  const theme = {
    fg: (color, text) =>
      `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : 2}m${text}\x1b[0m`,
  };
  const footerData = {
    getGitBranch: () => branch,
    getExtensionStatuses: () => statuses,
    onBranchChange: (fn) => {
      callback = fn;
      return () => {
        callback = undefined;
        disposals++;
      };
    },
  };
  footerStatus(pi);
  return {
    handlers,
    pi,
    ctx,
    statuses,
    footerData,
    renderers,
    renderStats: (entry = sessionManager.getLeafEntry(), width = 120) => {
      const component = renderers.get("footer-status:timing")(entry, {}, theme);
      return component?.render(width).map(strip).join("\n") ?? "";
    },
    footer: createFooterStatus(pi, ctx, theme, footerData),
    theme,
    tui: { requestRender: () => renders++ },
    get renders() {
      return renders;
    },
    get disposals() {
      return disposals;
    },
    setThinking: (value) => {
      thinking = value;
    },
    setSettings: (value) => {
      settings = value;
    },
    setAuth: (value) => {
      auth = value;
    },
    setUsage: (value) => {
      contextUsage = value;
    },
    changeBranch: (value) => {
      branch = value;
      callback?.();
    },
  };
}

test("footer keeps billing/context/model and moves extension statuses to the second line", () => {
  const f = setup();
  assert.match(
    strip(f.footer.render(120)[0]),
    /\$0\.000 \| 8\.0%\/200k \| gpt-6\.1-sol \(sub\) • high$/,
  );
  assert.equal(f.footer.render(120).length, 1);
  f.ctx.sessionManager.appendMessage({ role: "assistant", usage: usage() });
  f.statuses.set("gkd-auto", "GKD Auto · on");
  f.statuses.set("codex-settings:model-probe", "\x1b[2m| Model Probe |\x1b[0m");
  f.statuses.set("codex-settings", "| Codex Fast |");
  const lines = f.footer.render(120).map(strip);
  assert.equal(lines.length, 2);
  assert.match(
    lines[0],
    /^~\/project \(main\)\s+\$0\.010 \| 8\.0%\/200k \| gpt-6\.1-sol \(sub\) • high$/,
  );
  assert.doesNotMatch(lines.join("\n"), /\$[\d.]+ \(sub\)|\(auto\)/);
  assert.equal(visibleWidth(lines[0]), 120);
  assert.doesNotMatch(lines.join("\n"), /TPS|TTFT|↑|↓|CH|My session/);
  assert.equal(lines[1], "| Codex Fast | | Model Probe | GKD Auto · on");
  assert.ok(!lines[1].includes("gpt-"));
  f.statuses.clear();
  assert.equal(f.footer.render(120).length, 1);
});

test("narrow layouts preserve useful fields, compact paths and never overflow wide or multiline text", () => {
  const f = setup();
  const path = "~/project";
  const baseLocation = `${path} (main)`;
  const model = "gpt-6.1-sol";
  const info = `${model} • high`;
  const context = `8.0%/200k | ${info}`;
  const billing = `$0.000 | ${context}`;
  const full = `$0.000 | 8.0%/200k | ${model} (sub) • high`;
  const layouts = [
    [path.length, path],
    [baseLocation.length, baseLocation],
    ...[model, info, context, billing, full].map((right) => [
      baseLocation.length + 2 + right.length,
      `${baseLocation}  ${right}`,
    ]),
  ];
  for (let i = 0; i < layouts.length; i++) {
    const [width, expected] = layouts[i];
    assert.equal(strip(f.footer.render(width)[0]), expected);
    if (i > 0)
      assert.equal(strip(f.footer.render(width - 1)[0]).replace(/ {2,}/g, "  "), layouts[i - 1][1]);
  }
  assert.equal(strip(f.footer.render(5)[0]), "~/...");
  f.changeBranch(null);
  assert.equal(strip(f.footer.render(path.length + 2 + model.length)[0]), `${path}  ${model}`);

  f.changeBranch("功能分支");
  f.statuses.set("custom", "\x1b[33m中文状态🧪\n第二行\t内容\r尾部\x1b[0m");
  const root = parse(process.cwd()).root;
  for (const [cwd, expanded, compact] of [
    [
      join(process.env.HOME, "Developer", "github", "pi-packages"),
      "~/Developer/github/pi-packages",
      "~/D/g/pi-packages",
    ],
    [
      join(process.env.HOME, ".worktrees", "🧪实验", "中文项目"),
      "~/.worktrees/🧪实验/中文项目",
      "~/.w/🧪/中文项目",
    ],
    [join(process.env.HOME, "Developer", "project") + sep, "~/Developer/project", "~/D/project"],
    [join(root, "opt", "company", "demo"), `${root}opt/company/demo`, `${root}o/c/demo`],
    [process.env.HOME, "~", "~"],
    [root, root, root],
  ]) {
    f.ctx.sessionManager.getCwd = () => cwd;
    const location = `${expanded.replaceAll("/", sep)} (功能分支)`;
    const compactLocation = `${compact.replaceAll("/", sep)} (功能分支)`;
    const fullWidth = visibleWidth(location) + 2 + visibleWidth(full);
    assert.equal(strip(f.footer.render(fullWidth)[0]), `${location}  ${full}`);
    if (expanded !== compact)
      assert.ok(strip(f.footer.render(fullWidth - 1)[0]).startsWith(compactLocation));
    assert.equal(strip(f.footer.render(visibleWidth(compact))[0]), compact.replaceAll("/", sep));
    for (const width of [0, 1, 5, 18, 30, 45, 80, fullWidth]) {
      for (const line of f.footer.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${cwd}: ${width}`);
        assert.doesNotMatch(line, /[\r\n\t]/);
      }
    }
    assert.equal(strip(f.footer.render(fullWidth)[1]), "中文状态🧪 第二行 内容 尾部");
    assert.equal(
      strip(f.footer.render(fullWidth)[0]),
      `${location}  ${full}`,
      "widening restores the path",
    );
  }
});

test("usage matches cumulative session billing, including tools, summaries, and abandoned branches", () => {
  const f = setup();
  const manager = f.ctx.sessionManager;
  const first = manager.appendMessage({ role: "assistant", usage: usage() });
  manager.appendMessage({ role: "toolResult", usage: usage() });
  manager.branch(first);
  manager.appendUsage("cache_warm", "test", "test", usage());
  manager.appendCompaction("summary", first, 10000, undefined, false, usage());
  manager.branchWithSummary(first, "branch summary", undefined, false, usage());
  const snapshot = appendTimedResponse(f);
  assert.match(
    f.renderStats(manager.getEntry(snapshot)),
    /in 6\.0k, out 1\.2k, cr 18k, total 25k, CH 75\.0%$/,
  );
  assert.match(
    strip(f.footer.render(120)[0]),
    /\$0\.060 \| 8\.0%\/200k \| gpt-6\.1-sol \(sub\) • high$/,
  );
  manager.appendMessage({ role: "assistant", usage: usage(3000) });
  assert.match(
    f.renderStats(manager.getEntry(snapshot)),
    /in 6\.0k, out 1\.2k, cr 18k, total 25k, CH 75\.0%$/,
    "later usage cannot rewrite an earlier snapshot",
  );
  assert.match(
    strip(f.footer.render(120)[0]),
    /\$0\.070 \| 8\.0%\/200k \| gpt-6\.1-sol \(sub\) • high$/,
  );
});

test("a complete run emits one snapshot, aggregating requests but excluding tools from TPS", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const f = setup();
  let footer;
  f.ctx.ui = {
    setFooter: (factory) => {
      footer = factory(f.tui, f.theme, f.footerData);
    },
  };
  f.handlers.get("session_start")({}, f.ctx);
  f.handlers.get("before_agent_start")({}, f.ctx);
  f.handlers.get("before_provider_request")({}, f.ctx);
  const update = (type, delta = "") =>
    f.handlers.get("message_update")({ assistantMessageEvent: { type, delta } }, f.ctx);
  now = 600;
  update("text_start");
  update("thinking_delta");
  update("text_delta");
  now = 1100;
  update("thinking_delta", "first token");
  now = 2100;
  update("text_delta", "later token");
  now = 3100;
  const message = { role: "assistant", usage: usage(), stopReason: "toolUse", durationMs: 3000 };
  f.handlers.get("message_end")({ message }, f.ctx);
  const messageEntryId = f.ctx.sessionManager.appendMessage(message);
  now = 13100;
  f.ctx.sessionManager.appendMessage({ role: "toolResult", content: [] });
  f.handlers.get("turn_end")({ messageEntryId, message }, f.ctx);
  assert.equal(f.renders, 0, "tool turns never emit statistics");
  assert.equal(f.renderStats(), "");
  assert.equal(footer.render(120).length, 1);
  assert.equal(message.durationMs, 3000, "native duration is not overwritten");

  const finishResponse = () => {
    f.handlers.get("before_provider_request")({}, f.ctx);
    now += 100;
    update("text_delta", "next");
    now += 1000;
    const next = { ...message, stopReason: "stop" };
    f.handlers.get("message_end")({ message: next }, f.ctx);
    const id = f.ctx.sessionManager.appendMessage(next);
    f.handlers.get("turn_end")({ messageEntryId: id, message: next }, f.ctx);
  };
  f.handlers.get("agent_end")({}, f.ctx);
  now += 1000;
  f.handlers.get("before_agent_start")({}, f.ctx);
  finishResponse();
  f.handlers.get("agent_end")({}, f.ctx);
  assert.equal(f.renders, 0, "even agent_end may be followed by automatic continuation");
  now += 1000;
  f.handlers.get("before_agent_start")({}, f.ctx);
  finishResponse();
  f.handlers.get("agent_end")({}, f.ctx);
  assert.equal(f.renders, 0, "a final-looking answer followed by queued work is not final");
  now += 1000;
  f.handlers.get("agent_settled")({ aborted: false }, f.ctx);
  assert.equal(f.renders, 1);
  const entry = f.ctx.sessionManager.getLeafEntry();
  const restored = setup();
  const stats = "TPS 115.4, TTFT 1.00s, in 3.0k, out 600, cr 9.0k, total 13k, CH 75.0%, time 18.2s";
  assert.equal(entry.data.requestMs, 5200);
  assert.equal(entry.data.outputTokens, 600);
  assert.equal(entry.data.elapsedMs, 18200);
  for (let width = 0; width <= 120; width++) {
    const line = restored.renderStats(entry, width);
    assert.ok(visibleWidth(line) <= width);
    if (width >= stats.length) assert.equal(line, stats);
    assert.doesNotMatch(line, /\$|%\//);
  }
  f.handlers.get("agent_settled")({ aborted: false }, f.ctx);
  assert.equal(f.ctx.sessionManager.getEntries().filter((e) => e.type === "custom").length, 1);
  for (const reset of ["session_tree", "session_shutdown", "session_start"]) {
    f.handlers.get(reset)({}, f.ctx);
    now += 100000;
    f.handlers.get("before_agent_start")({}, f.ctx);
    finishResponse();
    f.handlers.get("agent_settled")({ aborted: false }, f.ctx);
    assert.match(
      f.renderStats(),
      /^TPS 181\.8, TTFT 0\.10s, in 1\.0k, out 200, cr 3\.0k, total 4\.2k, CH 75\.0%, time 1\.1s$/,
      `${reset} and settle reset run timing and usage, excluding idle time`,
    );
    assert.equal(restored.renderStats(entry), stats, "older snapshots remain unchanged");
  }
});

function appendTimedResponse(f, generationMs = 4000, ttftMs = 1000, extra = {}) {
  const messageEntryId = f.ctx.sessionManager.appendMessage({
    role: "assistant",
    usage: usage(),
    stopReason: "stop",
    ...extra,
  });
  const data = {
    messageEntryId,
    requestMs: generationMs + ttftMs,
    ttftMs,
    outputTokens: extra.usage?.output ?? usage().output,
  };
  const stats = formatResponseStats(f.ctx.sessionManager.getEntries(), data);
  return f.ctx.sessionManager.appendCustomEntry("footer-status:timing", { ...data, stats });
}

test("each response keeps its own snapshot across later replies, branches, and old timing entries", () => {
  const f = setup();
  const manager = f.ctx.sessionManager;
  const first = appendTimedResponse(f);
  manager.appendMessage({ role: "toolResult", usage: usage(), durationMs: 1 });
  manager.appendUsage("cache_warm", "test", "test", usage());
  const firstEntry = manager.getEntry(first);
  assert.match(f.renderStats(firstEntry), /TPS 40\.0, TTFT 1\.00s/);
  const second = appendTimedResponse(f, 1600, 250);
  assert.match(f.renderStats(), /TPS 108\.1, TTFT 0\.25s/);
  assert.match(f.renderStats(firstEntry), /TPS 40\.0, TTFT 1\.00s/);
  manager.branch(first);
  assert.match(f.renderStats(), /TPS 40\.0, TTFT 1\.00s/);
  assert.match(f.renderStats(manager.getEntry(second)), /TPS 108\.1, TTFT 0\.25s/);
  manager.appendCustomEntry("footer-status:timing", {
    messageEntryId: "wrong-response",
    generationMs: 10,
    ttftMs: 10,
  });
  assert.equal(f.renderStats(), "", "old entries without snapshots stay hidden");
  assert.equal(formatResponseStats(manager.getEntries(), manager.getLeafEntry().data), "");
  for (const data of [null, {}, { stats: 42 }]) assert.equal(f.renderStats({ data }), "");
  assert.equal(f.renderStats({ data: { stats: "TPS 1.0\nTTFT 0.5s" } }), "TPS 1.0 TTFT 0.5s");
  assert.equal(
    f.renderStats({ ...firstEntry, data: { ...firstEntry.data, stats: "TPS 50.0, TTFT 1.00s" } }),
    "TPS 50.0, TTFT 1.00s",
    "saved legacy TPS is not recalculated",
  );
});

test("invalid timings and failed or empty responses do not produce TPS or TTFT", () => {
  const f = setup();
  for (const [requestMs, ttft, extra] of [
    [undefined, 10, {}],
    [-1, 10, {}],
    [NaN, 10, {}],
    [Infinity, 10, {}],
    [1000, undefined, {}],
    [1000, -1, {}],
    [1000, NaN, {}],
    [1000, Infinity, {}],
    [1000, 100, { usage: { ...usage(), output: 0 } }],
    [1000, 100, { usage: { ...usage(), output: -1 } }],
    [1000, 100, { usage: { ...usage(), output: NaN } }],
    [1000, 100, { usage: { ...usage(), output: Infinity } }],
    [1000, 100, { stopReason: "error" }],
    [1000, 100, { stopReason: "aborted" }],
  ]) {
    const id = f.ctx.sessionManager.appendMessage({
      role: "assistant",
      usage: usage(),
      stopReason: "stop",
      ...extra,
    });
    const stats = formatResponseStats(f.ctx.sessionManager.getEntries(), {
      messageEntryId: id,
      requestMs,
      ttftMs: ttft,
      outputTokens: extra.usage?.output ?? usage().output,
    });
    assert.doesNotMatch(stats, /TPS|TTFT/);
  }
  appendTimedResponse(f, 0, 1000);
  assert.match(
    f.renderStats(),
    /^TPS 200\.0, TTFT 1\.00s, /,
    "buffered output still uses the full request duration",
  );
  appendTimedResponse(f, 1000, 0);
  assert.match(f.renderStats(), /^TPS 200\.0, TTFT 0\.00s, /);
  appendTimedResponse(f, 0, 0);
  assert.match(f.renderStats(), /^TTFT 0\.00s, /);
  assert.doesNotMatch(f.renderStats(), /TPS/);
  const data = f.ctx.sessionManager.getLeafEntry().data;
  const entries = f.ctx.sessionManager.getEntries();
  const baseline = formatResponseStats(entries, data);
  for (const elapsedMs of [undefined, null, "120200", -1, NaN, Infinity]) {
    assert.equal(formatResponseStats(entries, { ...data, elapsedMs }), baseline);
  }
  assert.equal(formatResponseStats(entries, { ...data, elapsedMs: 0 }), `${baseline}, time 0.0s`);
  assert.equal(
    formatResponseStats(entries, { ...data, elapsedMs: 120200 }),
    `${baseline}, time 120.2s`,
  );
});

test("fresh requests, cancellation, and lifecycle resets cannot reuse a previous first token", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  for (const reset of [
    "before_provider_request",
    "agent_end",
    "session_tree",
    "session_shutdown",
  ]) {
    const f = setup();
    f.handlers.get("before_agent_start")({}, f.ctx);
    f.handlers.get("before_provider_request")({}, f.ctx);
    now += 100;
    f.handlers.get("message_update")(
      { assistantMessageEvent: { type: "text_delta", delta: "first" } },
      f.ctx,
    );
    f.handlers.get(reset)({}, f.ctx);
    now += 1000;
    const message = { role: "assistant", usage: usage(), stopReason: "stop" };
    f.handlers.get("message_end")({ message }, f.ctx);
    const messageEntryId = f.ctx.sessionManager.appendMessage(message);
    f.handlers.get("turn_end")({ messageEntryId, message }, f.ctx);
    f.handlers.get("agent_settled")({ aborted: false }, f.ctx);
    assert.equal(
      f.ctx.sessionManager.getEntries().filter((e) => e.type === "custom").length,
      0,
      reset,
    );
  }
  for (const [type, stopReason] of [
    ["text_delta", "stop"],
    ["thinking_delta", "stop"],
    ["toolcall_delta", "stop"],
    ["text_delta", "toolUse"],
    ["text_delta", "aborted"],
    ["text_delta", "error"],
    ["text_delta", "cancelAtSettle"],
  ]) {
    const f = setup();
    f.handlers.get("before_agent_start")({}, f.ctx);
    f.handlers.get("before_provider_request")({}, f.ctx);
    now += 50;
    f.handlers.get("message_update")({ assistantMessageEvent: { type, delta: "first" } }, f.ctx);
    now += 1000;
    const message = {
      role: "assistant",
      usage: usage(),
      stopReason: stopReason === "cancelAtSettle" ? "stop" : stopReason,
    };
    f.handlers.get("message_end")({ message }, f.ctx);
    const messageEntryId = f.ctx.sessionManager.appendMessage(message);
    f.handlers.get("turn_end")({ messageEntryId, message }, f.ctx);
    assert.equal(f.renderStats(), "", "no statistics before settle");
    f.handlers.get("agent_settled")({ aborted: stopReason === "cancelAtSettle" }, f.ctx);
    assert.equal(
      f.ctx.sessionManager.getEntries().filter((e) => e.type === "custom").length,
      stopReason === "stop" ? 1 : 0,
    );
    if (stopReason === "stop") assert.match(f.renderStats(), /^TPS 190\.5, TTFT 0\.05s, /);
  }
});

test("live model, thinking, and context warning update while session names stay hidden", () => {
  const f = setup();
  f.setThinking("off");
  f.setSettings({ compaction: { enabled: false } });
  f.setUsage({ percent: null, contextWindow: 128000 });
  assert.match(
    strip(f.footer.render(120)[0]),
    /\$0\.000 \| \?\/128k \| gpt-6\.1-sol \(sub\) • thinking off$/,
  );
  assert.equal(f.footer.render(120).length, 1);
  assert.doesNotMatch(strip(f.footer.render(120)[0]), /\$[\d.]+ \(sub\)|\(auto\)/);
  f.setAuth(false);
  f.ctx.model = { ...f.ctx.model, provider: "openai" };
  assert.match(strip(f.footer.render(120)[0]), /gpt-6\.1-sol \(api\) • thinking off$/);
  f.ctx.model = { provider: "local", id: "本地模型", reasoning: false, contextWindow: 64000 };
  f.ctx.sessionManager.appendSessionInfo("Renamed");
  assert.match(
    strip(f.footer.render(120)[0]),
    /^~\/project \(main\)\s+\?\/128k \| 本地模型 \(local\)$/,
  );
  assert.doesNotMatch(strip(f.footer.render(120)[0]), /Renamed/);
  f.setUsage({ percent: 75, contextWindow: 64000 });
  assert.ok(f.footer.render(120)[0].includes("\x1b[33m75.0%/64k"));
  f.setUsage({ percent: 95, contextWindow: 64000 });
  assert.ok(f.footer.render(120)[0].includes("\x1b[31m95.0%/64k"));
  f.ctx.model = undefined;
  f.setUsage(undefined);
  assert.match(strip(f.footer.render(120)[0]), /0\.0%\/0 \| no-model$/);
  assert.equal(f.footer.render(120).length, 1);
});

test("only TUI installs the footer; Git branch rerenders and disposal unsubscribes", () => {
  const f = setup();
  const factories = [];
  f.ctx.ui = { setFooter: (factory) => factories.push(factory) };
  const start = f.handlers.get("session_start");
  for (const mode of ["rpc", "print", "json"]) {
    const ctx = { ...f.ctx, mode };
    start({}, ctx);
    f.handlers.get("before_agent_start")({}, ctx);
    f.handlers.get("before_provider_request")({}, ctx);
    f.handlers.get("message_update")(
      { assistantMessageEvent: { type: "text_delta", delta: "first" } },
      ctx,
    );
    const message = { role: "assistant", usage: usage(), stopReason: "stop" };
    f.handlers.get("message_end")({ message }, ctx);
    f.handlers.get("turn_end")({ messageEntryId: "unused", message }, ctx);
    f.handlers.get("agent_settled")({ aborted: false }, ctx);
  }
  assert.equal(f.ctx.sessionManager.getEntries().filter((e) => e.type === "custom").length, 0);
  assert.equal(factories.length, 0);
  start({}, f.ctx);
  const footer = factories[0](f.tui, f.theme, f.footerData);
  f.changeBranch("updated");
  assert.equal(f.renders, 1);
  assert.match(strip(footer.render(120)[0]), /\(updated\)/);
  footer.dispose();
  assert.equal(f.disposals, 1);
  f.changeBranch("later");
  assert.equal(f.renders, 1);
  start({ reason: "reload" }, f.ctx);
  assert.equal(factories.length, 2);
});

test("real Pi SDK persists one snapshot per tool-using conversation without adding it to model context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "footer-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ai = new URL("../../pi-ai/dist/", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { fauxProvider } = await import(new URL("providers/faux.js", ai).href);
  const { createAssistantMessageEventStream } = await import(
    new URL("utils/event-stream.js", ai).href
  );
  const model = {
    ...fauxProvider().getModel(),
    provider: "footer-test",
    api: "openai-completions",
  };
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let now = 100;
  let requests = 0;
  t.mock.method(performance, "now", () => now);
  runtime.registerProvider(model.provider, {
    api: model.api,
    apiKey: "offline",
    models: [model],
    streamSimple: (_model, context, options) => {
      assert.doesNotMatch(
        JSON.stringify(context.messages),
        /footer-status:timing|generationMs|ttftMs|elapsedMs/,
      );
      requests++;
      assert.equal(appended.length, Math.floor((requests - 1) / 2), "no intermediate snapshots");
      const useTool = requests % 2 === 1;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        usage: usage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const emit = async () => {
        const start = now;
        await options.onPayload({});
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        await setImmediate();
        now = start + 1000;
        message.content = [{ type: "text", text: "hello" }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial: message });
        await setImmediate();
        now = start + 3000;
        if (useTool) {
          message.content.push({
            type: "toolCall",
            id: `footer-${requests}`,
            name: "footer_test",
            arguments: {},
          });
          message.stopReason = "toolUse";
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      };
      void emit().catch((error) =>
        stream.push({
          type: "error",
          reason: "error",
          error: { ...message, stopReason: "error", errorMessage: String(error) },
        }),
      );
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    extensionFactories: [
      footerStatus,
      (pi) => {
        pi.registerTool({
          name: "footer_test",
          label: "Footer test",
          description: "Offline timing test",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            assert.equal(appended.length, Math.floor((requests - 1) / 2));
            now += 10000;
            return { content: [{ type: "text", text: "tool done" }], usage: usage(2000) };
          },
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
  const manager = SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: runtime,
    model: runtime.getModel(model.provider, model.id),
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
  });
  t.after(() => session.dispose());
  const errors = [];
  const appended = [];
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "entry_appended" && event.entry.type === "custom")
      appended.push(event.entry);
  });
  t.after(unsubscribe);
  let factory;
  await session.bindExtensions({
    mode: "tui",
    uiContext: {
      setFooter: (value) => {
        factory = value;
      },
    },
    onError: (error) => errors.push(error),
  });
  await session.prompt("hello");
  await session.waitForIdle();
  now += 10000;
  await session.prompt("again");
  await session.waitForIdle();
  assert.deepEqual(errors, []);
  assert.equal(requests, 4);
  const reopened = SessionManager.open(manager.getSessionFile());
  const timings = reopened
    .getEntries()
    .filter((e) => e.type === "custom" && e.customType === "footer-status:timing");
  assert.equal(timings.length, 2);
  assert.deepEqual(
    appended.map((entry) => entry.data.stats),
    timings.map((entry) => entry.data.stats),
    "live UI and restored history receive the same snapshots",
  );
  for (const entry of timings) {
    assert.equal(entry.data.ttftMs, 1000);
    assert.equal(entry.data.requestMs, 6000);
    assert.equal(entry.data.outputTokens, 400);
    assert.equal(entry.data.elapsedMs, 16000);
    assert.equal(reopened.getEntry(entry.data.messageEntryId).message.role, "assistant");
  }
  const f = setup();
  const footer = factory(f.tui, f.theme, f.footerData);
  assert.equal(footer.render(120).length, 1);
  const renderer = session.extensionRunner.getEntryRenderer("footer-status:timing");
  assert.equal(
    renderer(timings[0], {}, f.theme).render(120).map(strip).join(""),
    "TPS 66.7, TTFT 1.00s, in 4.0k, out 600, cr 9.0k, total 14k, CH 69.2%, time 16.0s",
  );
  assert.equal(
    renderer(timings[1], {}, f.theme).render(120).map(strip).join(""),
    "TPS 66.7, TTFT 1.00s, in 4.0k, out 600, cr 9.0k, total 14k, CH 69.2%, time 16.0s",
  );
  footer.dispose();
});
