import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

test("Skill installs alone with complete local references and executable Lark resources", async (t) => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./skills/gkd-workloop"]);
  assert.ok(manifest.pi.extensions.includes("./extensions/gkd-workflow/index.ts"));
  assert.ok(manifest.files.includes("skills"));
  const root = await mkdtemp(join(tmpdir(), "gkd-skill-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = join(root, "gkd-workloop");
  await cp(new URL("../skills/gkd-workloop/", import.meta.url), skill, { recursive: true });
  const discovered = loadSkillsFromDir({ dir: skill, source: "path" });
  assert.deepEqual(discovered.diagnostics, []);
  assert.deepEqual(
    discovered.skills.map((entry) => entry.name),
    ["gkd-workloop"],
  );

  for (const entry of await readdir(skill, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(entry.parentPath, entry.name);
    const source = await readFile(path, "utf8");
    for (const [, link] of source.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|#)/.test(link)) continue;
      const target = await realpath(resolve(dirname(path), link.split("#")[0]));
      const within = relative(await realpath(skill), target);
      assert.ok(!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`), link);
    }
  }

  // Installation paths may contain symlinks; entry detection must still run main.
  const installed = join(root, "installed");
  await symlink(skill, installed, process.platform === "win32" ? "junction" : "dir");
  // Run only the copied resources, outside this repository and without its dependencies.
  const invoke = (script, args = [], input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          "--experimental-strip-types",
          join(installed, "integrations/lark/scripts", script),
          ...args,
        ],
        { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "data") } },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve(JSON.parse(stdout));
        },
      );
      child.stdin.end(input);
    });
  assert.equal((await invoke("preflight.ts", ["--invalidate"])).status, "invalidated");
  const bindings = await invoke("bindings.ts", [], JSON.stringify({ action: "read" }));
  assert.equal(bindings.status, "ready");
  assert.deepEqual(bindings.bindings, []);
  await assert.rejects(invoke("create.ts", ["not-a-url"]), (error) => {
    assert.match(error.stderr, /创建未开始/);
    return true;
  });
});
