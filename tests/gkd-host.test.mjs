import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadState } from "../extensions/gkd-workflow/state.ts";

// Use the host's own offline model fixture, not another model client or a test-only workflow runner.
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(
  new URL(
    "../../pi-ai/dist/providers/faux.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const exec = promisify(execFile);

test(
  "real Pi SDK runs manual and automatic FAST / approved STANDARD / safe resume offline",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "gkd-host-"));
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    try {
      for (const [standard, resume, auto] of [
        [false, false, false],
        [true, false, false],
        [false, true, false],
        [false, false, true],
        [true, false, true],
      ]) {
        await writeFile(
          join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json"),
          JSON.stringify({ autoEnabled: auto }),
        );
        const cwd = join(
          root,
          `${standard ? "standard" : resume ? "resume" : "fast"}${auto ? "-auto" : ""}`,
        );
        await exec("git", ["init", "-q", cwd]);
        await writeFile(join(cwd, "value.txt"), "before");
        await exec("git", ["-C", cwd, "add", "."]);
        await exec("git", [
          "-C",
          cwd,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-qm",
          "initial",
        ]);
        const settingsManager = SettingsManager.inMemory(
          { compaction: { enabled: false }, retry: { enabled: false } },
          { projectTrusted: true },
        );
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir: process.env.PI_CODING_AGENT_DIR,
          settingsManager,
          additionalExtensionPaths: [
            fileURLToPath(new URL("../extensions/gkd-workflow/index.ts", import.meta.url)),
          ],
          noSkills: true,
          noThemes: true,
          noContextFiles: true,
          noPromptTemplates: true,
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const runtime = await ModelRuntime.create({
          authPath: join(root, "auth.json"),
          modelsPath: null,
          refreshOnCreate: false,
        });
        const faux = fauxProvider({ provider: `gkd-test-${standard}`, tokensPerSecond: 100000 });
        runtime.registerNativeProvider(faux.provider);
        const manager = SessionManager.inMemory(cwd);
        const current = () => {
          const marker = manager
            .getBranch()
            .findLast((entry) => entry.type === "custom" && entry.customType === "gkd-task");
          return marker ? loadState(manager.getSessionId(), marker.data.taskId) : undefined;
        };
        const command = `${JSON.stringify(process.execPath)} -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("value.txt","utf8"),"after")'`;
        const plan = `Change value.txt from before to after. Given the stored value is before, when updated, then it is after. Verify with: ${command}`;
        const report = (action, extra = {}) =>
          fauxAssistantMessage(
            fauxToolCall("gkd_report", {
              taskId: current().taskId,
              planVersion: current().planVersion,
              action,
              ...extra,
            }),
          );
        const steps = [
          () =>
            fauxAssistantMessage(fauxToolCall("gkd_workloop_start", { kind: "development" })),
          (context) => {
            assert.match(
              JSON.stringify(context.messages),
              /Task Route Policy/,
              "routing policy reaches the real provider request or tool-result context",
            );
            return fauxAssistantMessage(
              fauxToolCall("gkd_judge_route", {
                response: JSON.stringify({
                  intent: "development",
                  route: standard ? "STANDARD" : "FAST",
                  confidence: 1,
                  riskLevel: standard ? "medium" : "low",
                  reasons: ["Known local change"],
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
                }),
              }),
            );
          },
          ...(resume
            ? [
                () =>
                  report("blocked", {
                    reason: "Wait for the user to resolve an external prerequisite",
                  }),
              ]
            : []),
          ...(standard ? [() => report("plan", { plan })] : []),
          () =>
            fauxAssistantMessage(fauxToolCall("write", { path: "value.txt", content: "after" })),
          () => report("implemented", { summary: "Changed value.txt from before to after" }),
          () => fauxAssistantMessage(fauxToolCall("bash", { command })),
          () =>
            report("verified", {
              passed: true,
              summary:
                "The file-content assertion ran successfully; the stored value meets the acceptance criterion.",
            }),
        ];
        faux.setResponses(steps);
        const { session } = await createAgentSession({
          cwd,
          agentDir: process.env.PI_CODING_AGENT_DIR,
          modelRuntime: runtime,
          model: faux.getModel(),
          resourceLoader: loader,
          settingsManager,
          sessionManager: manager,
        });
        const errors = [];
        try {
          await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
          const started = new Promise((resolve) => {
            const unsubscribe = session.subscribe((event) => {
              if (event.type !== "agent_start") return;
              unsubscribe();
              resolve();
            });
          });
          const task = "Change value.txt from before to after";
          const images = auto
            ? [
                {
                  type: "image",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                  mimeType: "image/png",
                },
              ]
            : undefined;
          await session.prompt(auto ? task : `/gkd-workloop ${task}`, { images });
          await started; // sendUserMessage starts asynchronously after the command returns.
          await session.waitForIdle();
          if (resume) {
            assert.equal(current().phase, "BLOCKED");
            await session.prompt("继续上次任务");
            await session.waitForIdle();
          }
          if (standard) {
            assert.equal(current().phase, "AWAITING_APPROVAL");
            assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "before");
            await session.prompt("批准当前计划");
            await session.waitForIdle();
          }
          assert.deepEqual(errors, []);
          assert.equal(
            current().phase,
            "COMPLETED",
            JSON.stringify(
              {
                state: current(),
                results: manager
                  .getBranch()
                  .filter(
                    (entry) => entry.type === "message" && entry.message.role === "toolResult",
                  )
                  .map((entry) => ({
                    tool: entry.message.toolName,
                    isError: entry.message.isError,
                    text: JSON.stringify(entry.message.content).slice(0, 300),
                  })),
                pending: faux.getPendingResponseCount(),
              },
              null,
              2,
            ),
          );
          assert.equal(current().validation.passed, true);
          assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "after");
          if (auto) {
            const userMessages = manager
              .getBranch()
              .filter((entry) => entry.type === "message" && entry.message.role === "user");
            const first = userMessages[0].message;
            assert.deepEqual(
              first.content,
              [{ type: "text", text: task }, ...images],
              "original text and attachments survive automatic routing",
            );
            assert.equal(
              userMessages.length,
              standard ? 2 : 1,
              "no duplicate kickoff or classification loop",
            );
          }
          assert.equal(faux.getPendingResponseCount(), 0);
          assert.equal(
            faux.state.callCount,
            steps.length,
            "no hidden extra provider turn before approval or after completion",
          );
        } finally {
          session.dispose();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
