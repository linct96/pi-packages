import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Use Pi's offline provider to check real resource expansion, not model compliance with prose.
const { fauxProvider, fauxAssistantMessage } = await import(
  new URL(
    "../../pi-ai/dist/providers/faux.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);

test(
  "real Pi loads the standalone Skill directly, through the command and in automatic mode offline",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "gkd-host-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    await mkdir(process.env.PI_CODING_AGENT_DIR);
    t.after(async () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(root, { recursive: true, force: true });
    });
    for (const mode of ["skill-only", "command", "auto"]) {
      const cwd = join(root, mode);
      await mkdir(cwd);
      await writeFile(
        join(process.env.PI_CODING_AGENT_DIR, "gkd-workflow.json"),
        JSON.stringify({ autoEnabled: mode === "auto" }),
      );
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager,
        additionalExtensionPaths:
          mode === "skill-only"
            ? []
            : [fileURLToPath(new URL("../extensions/gkd-workflow/index.ts", import.meta.url))],
        additionalSkillPaths: [fileURLToPath(new URL("../skills/gkd-workloop", import.meta.url))],
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
      const faux = fauxProvider({ provider: `gkd-test-${mode}`, tokensPerSecond: 100000 });
      runtime.registerNativeProvider(faux.provider);
      faux.setResponses([
        (context) => {
          assert.match(JSON.stringify(context.messages), /本 Skill 是完整工作流/);
          assert.match(JSON.stringify(context.messages), /skills\/gkd-workloop\/SKILL\.md/);
          assert.ok(context.tools.some((tool) => tool.name === "read"));
          assert.ok(!context.tools.some((tool) => tool.name.startsWith("gkd_")));
          return fauxAssistantMessage("Skill loaded");
        },
      ]);
      const manager = SessionManager.inMemory(cwd);
      const { session } = await createAgentSession({
        cwd,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        modelRuntime: runtime,
        model: faux.getModel(),
        resourceLoader: loader,
        settingsManager,
        sessionManager: manager,
      });
      try {
        const errors = [];
        await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
        const task = "说明用法，不执行任务";
        const images =
          mode === "auto"
            ? [
                {
                  type: "image",
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                  mimeType: "image/png",
                },
              ]
            : undefined;
        const started = new Promise((resolve) => {
          const off = session.subscribe((event) => {
            if (event.type !== "agent_start") return;
            off();
            resolve();
          });
        });
        const prompt =
          mode === "auto"
            ? task
            : `${mode === "command" ? "/gkd-workloop" : "/skill:gkd-workloop"} ${task}`;
        await session.prompt(prompt, { images });
        await started;
        await session.waitForIdle();
        assert.deepEqual(errors, []);
        assert.equal(faux.state.callCount, 1);
        assert.equal(faux.getPendingResponseCount(), 0);
        const users = manager
          .getBranch()
          .filter((entry) => entry.type === "message" && entry.message.role === "user");
        assert.equal(users.length, 1, "no duplicate kickoff or routing turn");
        if (mode === "auto")
          assert.deepEqual(users[0].message.content, [{ type: "text", text: task }, ...images]);
        assert.ok(
          !manager
            .getBranch()
            .some((entry) => entry.type === "custom" && entry.customType === "gkd-task"),
        );
      } finally {
        session.dispose();
      }
    }
  },
);
