import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createReadToolDefinition,
  truncateLine,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const execFileAsync = promisify(execFile);
const ENTRY_TYPE = "gkd-workflow-route";
const EVIDENCE_TOOL = "gkd_route_evidence";
const RESULT_TOOL = "gkd_judge_route";
const EMPTY_SIGNALS = {
  crossModule: false,
  architectureChange: false,
  breakingChange: false,
  securitySensitive: false,
  migrationRequired: false,
  designUncertainty: false,
};
type Signals = typeof EMPTY_SIGNALS;
const ASSESSMENT_KEYS = [
  "goalClear",
  "implementationClear",
  "impactControlled",
  "lowRisk",
  "verificationClear",
  "designDecisionRequired",
  "phasedImplementationRequired",
] as const;
type Assessment = Record<(typeof ASSESSMENT_KEYS)[number], boolean>;
type RawRoute = {
  intent: "development" | "operation" | "non_development";
  route: "FAST" | "STANDARD" | "DIRECT" | "NONE";
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  signals: Signals;
  assessment: Assessment;
};

export const ROUTE_POLICY = readFileSync(new URL("./policy.md", import.meta.url), "utf8").trim();
const ROUTE_WORKFLOW = readFileSync(new URL("./workflow.md", import.meta.url), "utf8").trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRouteResponse(text: string) {
  if (text.length > 16384) throw new Error("INVALID_ROUTE_SCHEMA");
  const raw: unknown = JSON.parse(text);
  const signals = isRecord(raw) ? raw.signals : null;
  const assessment = isRecord(raw) ? raw.assessment : null;
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== 7 ||
    (raw.intent !== "development" &&
      raw.intent !== "operation" &&
      raw.intent !== "non_development") ||
    (raw.route !== "FAST" &&
      raw.route !== "STANDARD" &&
      raw.route !== "DIRECT" &&
      raw.route !== "NONE") ||
    (raw.riskLevel !== "low" && raw.riskLevel !== "medium" && raw.riskLevel !== "high") ||
    typeof raw.confidence !== "number" ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1 ||
    !Array.isArray(raw.reasons) ||
    raw.reasons.length < 1 ||
    raw.reasons.length > 8 ||
    !raw.reasons.every(
      (reason) => typeof reason === "string" && reason.trim().length > 0 && reason.length <= 500,
    ) ||
    !isRecord(signals) ||
    Object.keys(signals).length !== 6 ||
    !Object.keys(EMPTY_SIGNALS).every((key) => typeof signals[key] === "boolean") ||
    !isRecord(assessment) ||
    Object.keys(assessment).length !== ASSESSMENT_KEYS.length ||
    !ASSESSMENT_KEYS.every((key) => typeof assessment[key] === "boolean")
  ) {
    throw new Error("INVALID_ROUTE_SCHEMA");
  }
  const result = raw as RawRoute;
  if (
    (result.intent === "development" && result.route !== "FAST" && result.route !== "STANDARD") ||
    (result.intent === "operation" &&
      (result.route !== "DIRECT" || Object.values(result.assessment).some(Boolean))) ||
    (result.intent === "non_development" && result.route === "DIRECT")
  )
    throw new Error("INVALID_ROUTE_SCHEMA");
  const forceStandard =
    result.riskLevel !== "low" ||
    Object.values(result.signals).some(Boolean) ||
    result.assessment.designDecisionRequired ||
    result.assessment.phasedImplementationRequired;
  const route =
    result.intent === "non_development"
      ? "NONE"
      : result.intent === "operation"
        ? "DIRECT"
        : forceStandard
          ? "STANDARD"
          : "FAST";
  const routeChanged = result.intent === "development" && route !== result.route;
  return {
    schemaVersion: "2.0",
    status: "ok",
    intent: result.intent,
    route,
    confidence: result.confidence,
    riskLevel:
      route === "NONE"
        ? "low"
        : route === "STANDARD" && result.riskLevel === "low"
          ? "medium"
          : result.riskLevel,
    reasons: routeChanged
      ? [
          ...result.reasons,
          route === "STANDARD"
            ? "存在明确风险、重要设计决策或依赖性分阶段实施要求，使用 STANDARD。"
            : "未报告明确的 STANDARD 触发项，使用默认 FAST；未知仍需在执行中核实。",
        ]
      : result.reasons,
    signals: route === "NONE" ? { ...EMPTY_SIGNALS } : result.signals,
    requiresPlan: route === "STANDARD",
    requiresApproval:
      route === "STANDARD" ||
      (route === "DIRECT" &&
        (result.riskLevel !== "low" || Object.values(result.signals).some(Boolean))),
    error: null,
  };
}

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const rangeSchema = {
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
};
const revisionSchema = Type.String({
  pattern: "^(HEAD([~^][0-9]*)*|[a-fA-F0-9]{7,40})$",
  maxLength: 100,
});
const evidenceSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("find"),
      Type.Literal("search"),
      Type.Literal("read"),
      Type.Literal("log"),
      Type.Literal("show"),
      Type.Literal("diff"),
      Type.Literal("blame"),
    ]),
    path: Type.Optional(Type.String({ minLength: 1 })),
    pattern: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    revision: Type.Optional(revisionSchema),
    to: Type.Optional(revisionSchema),
    ...rangeSchema,
  },
  { additionalProperties: false },
);

function isPrivatePath(path: string) {
  return (
    /(^|\/)(?:\.git|\.pi|\.agents|\.ssh|\.aws|\.gnupg|node_modules|dist|build|coverage)(\/|$)/i.test(
      path,
    ) ||
    /(^|\/)(?:\.env[^/]*|\.npmrc|\.netrc|(?:secrets?|credentials?)(?:[.-][^/]*)?)(\/|$)/i.test(path)
  );
}

function isEvidencePath(path: string) {
  return (
    !isPrivatePath(path) &&
    (/\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|c|h|cpp|hpp|cc|cxx|hxx|kt|kts|swift|rb|php|sh|css|scss|html|vue|svelte|sql|prisma|graphql|md|mdx|rst|txt|json|ya?ml|toml)$/.test(
      path,
    ) ||
      ["go.mod", "Makefile"].includes(basename(path)))
  );
}

function evidencePath(root: string, path: string) {
  const absolute = resolve(root, path.replace(/^@/, ""));
  const local = relative(root, absolute).replaceAll("\\", "/");
  if (local.split("/").includes("..") || isAbsolute(local) || isPrivatePath(local))
    throw new Error("UNSAFE_EVIDENCE_PATH");
  return { absolute, local };
}

async function checkedPath(root: string, path: string) {
  const target = evidencePath(root, path);
  if ((await realpath(target.absolute)) !== target.absolute)
    throw new Error("UNSAFE_EVIDENCE_PATH");
  return target;
}

async function readEvidenceFile(root: string, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const { absolute, local } = await checkedPath(root, path);
  if (!isEvidencePath(local)) throw new Error("UNSUPPORTED_EVIDENCE_PATH");
  const file = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) throw new Error("NOT_A_REGULAR_FILE");
    // shortcut: files and Git output are capped at 8 MiB; add streaming for larger evidence when needed.
    const buffer = Buffer.alloc(MAX_EVIDENCE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_EVIDENCE_BYTES) throw new Error("EVIDENCE_TOO_LARGE");
    const content = buffer.subarray(0, size);
    if (content.includes(0)) throw new Error("BINARY_EVIDENCE");
    return content;
  } finally {
    await file.close();
  }
}

async function* evidenceFiles(
  root: string,
  path: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  signal.throwIfAborted();
  const { absolute, local } = await checkedPath(root, path);
  const stat = await lstat(absolute);
  if (stat.isFile()) {
    if (isEvidencePath(local)) yield local;
  } else if (stat.isDirectory()) {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal.throwIfAborted();
      const child = local ? `${local}/${entry.name}` : entry.name;
      if (isPrivatePath(child) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* evidenceFiles(root, child, signal);
      else if (entry.isFile() && isEvidencePath(child)) yield child;
    }
  }
}

async function evidencePage(
  ctx: ExtensionToolContext,
  content: Buffer,
  offset: number,
  limit: number,
  signal: AbortSignal,
) {
  const result = await createReadToolDefinition(ctx.cwd, {
    operations: { access: async () => {}, readFile: async () => content },
  }).execute(
    "route-evidence-page",
    { path: "route-evidence.txt", offset, limit },
    signal,
    undefined,
    ctx,
  );
  return { content: result.content, details: result.details };
}

async function evidenceGit(root: string, args: string[], signal: AbortSignal) {
  // Disable executable helpers and lazy network fetches, even in trusted repositories.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const { stdout } = await execFileAsync(
    "git",
    [
      "--no-pager",
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-c",
      "core.attributesFile=",
      "-c",
      "log.showSignature=false",
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "buffer",
      timeout: 5000,
      maxBuffer: MAX_EVIDENCE_BYTES,
      signal,
    },
  );
  return stdout;
}

async function evidenceRevision(root: string, revision: string, signal: AbortSignal) {
  if (!/^(HEAD([~^][0-9]*)*|[a-fA-F0-9]{7,40})$/.test(revision) || revision.length > 100)
    throw new Error("INVALID_EVIDENCE_REVISION");
  return (
    await evidenceGit(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      signal,
    )
  )
    .toString("utf8")
    .trim();
}

async function historicalFile(root: string, revision: string, path: string, signal: AbortSignal) {
  const entry = (
    await evidenceGit(root, ["ls-tree", "-lz", revision, "--", path], signal)
  ).toString("utf8");
  if (!entry) return false;
  const file = /^100(?:644|755) blob [a-f0-9]+\s+(\d+)\t/.exec(entry);
  if (!file) throw new Error("HISTORICAL_FILE_UNAVAILABLE");
  if (Number(file[1]) > MAX_EVIDENCE_BYTES) throw new Error("EVIDENCE_TOO_LARGE");
  return true;
}

async function repositoryEvidence(
  ctx: ExtensionToolContext,
  args: Static<typeof evidenceSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!ctx.isProjectTrusted()) throw new Error("PROJECT_NOT_TRUSTED");
  if (!["find", "search", "read", "log", "show", "diff", "blame"].includes(args.action))
    throw new Error("INVALID_EVIDENCE_ACTION");
  const root = await realpath(ctx.cwd);
  const offset = args.offset ?? 1;
  const limit = args.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000
  )
    throw new Error("INVALID_EVIDENCE_RANGE");
  if (args.action === "read") {
    if (!args.path) throw new Error("EVIDENCE_PATH_REQUIRED");
    return evidencePage(
      ctx,
      await readEvidenceFile(root, args.path, signal),
      offset,
      limit,
      signal,
    );
  }
  if (args.action === "find" || args.action === "search") {
    if (
      args.action === "search" &&
      (!args.pattern || args.pattern.length > 500 || /[\r\n]/.test(args.pattern))
    )
      throw new Error("INVALID_SEARCH_PATTERN");
    const rows: string[] = [];
    let seen = 0;
    let bytes = 0;
    let skipped = 0;
    for await (const path of evidenceFiles(root, args.path ?? ".", signal)) {
      if (args.action === "find" && args.pattern && !matchesGlob(path, args.pattern)) continue;
      let matches: Iterable<string> = [path];
      if (args.action === "search") {
        let content: Buffer;
        try {
          content = await readEvidenceFile(root, path, signal);
        } catch {
          signal.throwIfAborted();
          skipped++;
          continue;
        }
        const pattern = args.pattern!;
        matches = (function* () {
          for (const [i, line] of content.toString("utf8").split("\n").entries()) {
            if (line.includes(pattern)) yield `${path}:${i + 1}: ${truncateLine(line, 2000).text}`;
          }
        })();
      }
      for (const row of matches) {
        signal.throwIfAborted();
        if (++seen < offset) continue;
        if (rows.length >= limit || bytes + Buffer.byteLength(row) > 50000) {
          return {
            content: [
              {
                type: "text" as const,
                text: `${rows.join("\n")}\n\n[More results. Repeat with offset=${offset + rows.length}, or narrow path/pattern. Skipped unreadable/binary/oversized files: ${skipped}.]`,
              },
            ],
            details: {},
          };
        }
        rows.push(row);
        bytes += Buffer.byteLength(row) + 1;
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `${rows.join("\n") || "No results found."}\n\n[Skipped unreadable/binary/oversized files: ${skipped}.]`,
        },
      ],
      details: {},
    };
  }
  const path = args.path === undefined ? undefined : evidencePath(root, args.path).local;
  if (path !== undefined && !isEvidencePath(path)) throw new Error("UNSUPPORTED_EVIDENCE_PATH");
  let output: Buffer;
  if (args.action === "log") {
    output = await evidenceGit(
      root,
      [
        "log",
        "--no-decorate",
        "--date=iso-strict",
        "--format=%H %ad %s",
        `--skip=${offset - 1}`,
        `--max-count=${limit + 1}`,
        "--",
        path ?? ".",
      ],
      signal,
    );
    const rows = output
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((row) => truncateLine(row, 2000).text);
    const page = await evidencePage(ctx, Buffer.from(rows.join("\n")), 1, limit, signal);
    const kept = page.details?.truncation?.outputLines ?? Math.min(limit, rows.length);
    return {
      content: [
        {
          type: "text" as const,
          text:
            rows.slice(0, kept).join("\n") +
            (kept < rows.length
              ? `\n\n[More commits. Repeat log with offset=${offset + kept}.]`
              : ""),
        },
      ],
      details: page.details,
    };
  }
  if (!path) throw new Error("EVIDENCE_PATH_REQUIRED");
  const revision = await evidenceRevision(root, args.revision ?? "HEAD", signal);
  const existed = await historicalFile(root, revision, path, signal);
  if (args.action !== "diff" && !existed) throw new Error("HISTORICAL_FILE_UNAVAILABLE");
  if (args.action === "show") {
    output = await evidenceGit(root, ["show", `${revision}:./${path}`], signal);
  } else if (args.action === "diff") {
    const to = args.to ? await evidenceRevision(root, args.to, signal) : undefined;
    if (to) await historicalFile(root, to, path, signal);
    else {
      try {
        await readEvidenceFile(root, path, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    output = await evidenceGit(
      root,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--unified=3",
        revision,
        ...(to ? [to] : []),
        "--",
        path,
      ],
      signal,
    );
  } else if (args.action === "blame") {
    output = await evidenceGit(
      root,
      ["blame", "--no-textconv", "--date=short", revision, "--", path],
      signal,
    );
  } else throw new Error("INVALID_EVIDENCE_ACTION");
  if (output.includes(0)) throw new Error("BINARY_EVIDENCE");
  return evidencePage(
    ctx,
    output.length ? output : Buffer.from("No differences found."),
    offset,
    limit,
    signal,
  );
}

function routeError(error: unknown, signal: AbortSignal) {
  const code = signal.aborted
    ? signal.reason?.name === "TimeoutError"
      ? "ROUTE_TIMEOUT"
      : "ROUTE_CANCELLED"
    : error instanceof SyntaxError
      ? "INVALID_JSON"
      : error instanceof Error &&
          ["TASK_TOO_LONG", "MODEL_UNAVAILABLE", "INVALID_ROUTE_SCHEMA"].includes(error.message)
        ? error.message
        : "ROUTE_FAILED";
  return {
    schemaVersion: "2.0",
    status: "error",
    intent: "unknown",
    route: "NONE",
    confidence: 0,
    riskLevel: "unknown",
    reasons: [],
    signals: { ...EMPTY_SIGNALS },
    requiresPlan: false,
    requiresApproval: false,
    error: code,
  };
}

type RouteReceiver = (result: Record<string, unknown>, ctx: ExtensionContext) => Promise<string>;

export function registerJudgeRoute(
  pi: ExtensionAPI,
  options: {
    allowEvidence?: (ctx: ExtensionContext) => boolean;
    canDebug?: () => boolean;
  } = {},
) {
  // Keep rendering results saved by earlier command-only versions.
  pi.registerEntryRenderer(
    ENTRY_TYPE,
    (entry) => new Text(JSON.stringify(entry.data, null, 2), 0, 0),
  );
  let active:
    | {
        prompt: string;
        inline: boolean;
        sessionId: string;
        tools: string[];
        completed: boolean;
        controller: AbortController;
        receiver?: RouteReceiver;
        handoffQueued?: boolean;
      }
    | undefined;
  function restoreTools() {
    const run = active;
    active = undefined;
    if (run) {
      run.controller.abort(new Error("Route debug request expired"));
      pi.setActiveTools(run.tools);
    }
  }
  function authorized(ctx: ExtensionContext) {
    return active && active.sessionId === ctx.sessionManager.getSessionId() && !active.completed;
  }

  pi.on("session_shutdown", restoreTools);
  pi.on("agent_settled", (_event, ctx) => {
    if (active?.handoffQueued) {
      active.handoffQueued = false;
      return;
    }
    if (active && !active.completed)
      ctx.ui.notify("分流调试已结束，未生成有效分类结果。", "warning");
    restoreTools();
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (
      !active ||
      !authorized(ctx) ||
      event.messageType !== "user" ||
      (!active.inline && event.prompt !== active.prompt)
    )
      return;
    const scope = active.receiver
      ? "GKD integration: the following routing policy and read-only/no-implementation instructions apply ONLY during ROUTING. After the Extension validates classification and changes phase, follow the development FSM instructions and tool permissions for that new phase.\n\n"
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n${scope}${ROUTE_POLICY}\n\n${ROUTE_WORKFLOW}`,
    };
  });
  pi.on("tool_call", (event, ctx) => {
    if (!active) {
      if (
        [EVIDENCE_TOOL, RESULT_TOOL].includes(event.toolName) &&
        !(event.toolName === EVIDENCE_TOOL && options.allowEvidence?.(ctx))
      ) {
        return {
          block: true,
          reason: "Use /gkd-judge-route to start route debugging.",
          terminate: true,
        };
      }
      return;
    }
    if (
      active.sessionId !== ctx.sessionManager.getSessionId() &&
      ![EVIDENCE_TOOL, RESULT_TOOL].includes(event.toolName)
    )
      return;
    if (!authorized(ctx) || ![EVIDENCE_TOOL, RESULT_TOOL].includes(event.toolName)) {
      return {
        block: true,
        reason: "Route debugging only permits its read-only evidence and result tools.",
        terminate: true,
      };
    }
  });

  pi.registerTool({
    name: EVIDENCE_TOOL,
    label: "GKD 分流证据",
    description:
      "Read-only investigation inside a trusted project. find: root-relative glob (e.g. **/*.md); search: case-sensitive literal keyword with path:line results; read: source/doc/config text. log: commit hash/date/subject; show: historical file text; diff: one file, revision (default HEAD) versus to (default working tree); blame: committed file attribution. Revisions accept HEAD ancestry or commit hashes only. offset is 1-based (matches/paths/commits or text lines); limit defaults to 100, max 2000. Output ~50 KiB; follow continuation notices or narrow scope. Files/Git output <=8 MiB; each call <=10s, each Git command <=5s. Excludes private paths, symlinks, binary files and generated/dependency directories. No shell, scripts, tests, model calls or delegation.",
    parameters: evidenceSchema,
    defaultActive: false,
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, args, signal, _onUpdate, ctx) {
      if (!authorized(ctx) && !options.allowEvidence?.(ctx))
        throw new Error("No active route investigation");
      const run = active;
      const investigationSignal = AbortSignal.any([
        signal ?? new AbortController().signal,
        ...(run ? [run.controller.signal] : []),
        AbortSignal.timeout(10000),
      ]);
      try {
        const result = await repositoryEvidence(ctx, args, investigationSignal);
        investigationSignal.throwIfAborted();
        if (active !== run || !(authorized(ctx) || options.allowEvidence?.(ctx)))
          throw new Error("Route investigation expired");
        return result;
      } catch (error) {
        investigationSignal.throwIfAborted();
        const code =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "EVIDENCE_UNAVAILABLE";
        return {
          content: [
            {
              type: "text",
              text: `Evidence unavailable: ${code}. Narrow the query or record the evidence gap; no safety conclusion follows.`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
  pi.registerTool({
    name: RESULT_TOOL,
    label: "GKD 任务路由识别",
    description:
      "Submit the main Agent's route assessment JSON for validation. No model calls, operations or development work.",
    parameters: Type.Object(
      { response: Type.String({ maxLength: 16384 }) },
      { additionalProperties: false },
    ),
    defaultActive: false,
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, args, signal, _onUpdate, ctx) {
      if (!authorized(ctx)) throw new Error("No active route debug request");
      signal?.throwIfAborted();
      let result: Record<string, unknown>;
      try {
        result = parseRouteResponse(args.response);
      } catch (error) {
        result = routeError(error, signal ?? new AbortController().signal);
      }
      const receiver = active!.receiver;
      active!.completed = true;
      let next = "";
      if (receiver) {
        restoreTools();
        next = await receiver(result, ctx);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) + next }],
        details: result,
        isError: result.status !== "ok",
        terminate: !receiver || result.status !== "ok",
      };
    },
    renderResult(result) {
      return new Text(JSON.stringify(result.details, null, 2), 0, 0);
    },
  });

  pi.registerCommand("gkd-judge-route", {
    description: "由主 Agent 调试 DIRECT / FAST / STANDARD / NONE 分流，不执行任务",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("用法：/gkd-judge-route <任务提示词>", "warning");
        return;
      }
      if (active || !ctx.isIdle() || options.canDebug?.() === false) {
        ctx.ui.notify("请等待当前任务结束后再启动分流调试。", "warning");
        return;
      }
      if (!ctx.model || task.length > 16000) {
        pi.appendEntry(
          ENTRY_TYPE,
          routeError(
            new Error(task.length > 16000 ? "TASK_TOO_LONG" : "MODEL_UNAVAILABLE"),
            new AbortController().signal,
          ),
        );
        return;
      }
      try {
        start(task, ctx);
      } catch {
        restoreTools();
        ctx.ui.notify("无法启动分流调试，请重试。", "error");
      }
    },
  });

  function start(
    task: string,
    ctx: ExtensionContext,
    receiver?: RouteReceiver,
    inlinePrompt?: string,
    queueWhenBusy = false,
  ) {
    if (active) throw new Error("Route investigation already active");
    active = {
      prompt: inlinePrompt ?? `GKD route debug ${randomUUID()}\n${JSON.stringify({ task })}`,
      inline: inlinePrompt !== undefined,
      sessionId: ctx.sessionManager.getSessionId(),
      tools: pi.getActiveTools(),
      completed: false,
      controller: new AbortController(),
      receiver,
      handoffQueued: queueWhenBusy,
    };
    pi.setActiveTools([EVIDENCE_TOOL, RESULT_TOOL]);
    if (inlinePrompt === undefined)
      pi.sendUserMessage(active.prompt, queueWhenBusy ? { deliverAs: "followUp" } : undefined);
  }
  return { start, stop: restoreTools, isActive: () => !!active };
}
