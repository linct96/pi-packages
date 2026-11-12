import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createTracker } from "../skills/gkd-workloop/integrations/lark/scripts/create.ts";
import {
  bindingsPath,
  manageBindings,
} from "../skills/gkd-workloop/integrations/lark/scripts/bindings.ts";
import {
  CACHE_TTL_MS,
  REQUIRED_SCOPES,
  checkLarkCli,
  invalidatePreflightCache,
  preflightCachePath,
  readPreflightCache,
} from "../skills/gkd-workloop/integrations/lark/scripts/preflight.ts";

const exec = promisify(execFile);

async function sandbox(t, prefix, keys) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("Lark preflight checks permissions, cache expiry, revocation and secret-free persistence", async (t) => {
  const previousPath = process.env.PATH;
  const root = await sandbox(t, "lark-preflight-", [
    "PATH",
    "PI_CODING_AGENT_DIR",
    "LARK_TEST_STATUS",
    "LARK_TEST_CALLS",
    "LARK_TEST_EXIT",
  ]);
  const bin = join(root, "bin");
  await mkdir(bin);
  process.env.PATH = bin;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.LARK_TEST_CALLS = join(root, "calls.ndjson");
  assert.equal((await checkLarkCli()).status, "missing-cli");
  assert.equal(await readPreflightCache(), undefined);
  await mkdir(preflightCachePath(), { recursive: true });
  await assert.rejects(checkLarkCli(), /无法读取.*缓存/);
  await assert.rejects(invalidatePreflightCache());
  await rm(preflightCachePath(), { recursive: true });
  await invalidatePreflightCache();
  assert.equal(await readPreflightCache(), undefined);
  await writeFile(
    join(bin, "lark-cli"),
    `#!${process.execPath}\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.LARK_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(process.env.LARK_TEST_STATUS || "{}");\nprocess.exitCode = Number(process.env.LARK_TEST_EXIT || 0);\n`,
    { mode: 0o700 },
  );
  process.env.PATH = `${bin}${delimiter}${previousPath || ""}`;
  const user = {
    status: "ready",
    verified: true,
    scope: REQUIRED_SCOPES.join(" "),
    token: "must-not-be-cached",
  };
  process.env.LARK_TEST_STATUS = JSON.stringify({
    identities: { user: { ...user, verified: false } },
  });
  assert.equal((await checkLarkCli()).status, "needs-auth");
  assert.equal(await readPreflightCache(), undefined);
  process.env.LARK_TEST_STATUS = JSON.stringify({
    identities: { user: { ...user, scope: "base:record:read" } },
  });
  const missing = await checkLarkCli();
  assert.equal(missing.status, "needs-auth");
  assert.ok(missing.missingScopes.includes("base:record:update"));
  assert.ok(!missing.missingScopes.includes("base:record:read"));
  assert.equal(await readPreflightCache(), undefined);
  process.env.LARK_TEST_STATUS = JSON.stringify({ identities: { user } });
  const script = fileURLToPath(
    new URL("../skills/gkd-workloop/integrations/lark/scripts/preflight.ts", import.meta.url),
  );
  const checked = JSON.parse(
    (await exec(process.execPath, ["--experimental-strip-types", script, "--force"])).stdout,
  );
  assert.equal(checked.status, "ready");
  assert.equal(checked.cached, false);
  assert.equal(checked.expiresAt - checked.checkedAt, CACHE_TTL_MS);
  const cache = JSON.parse(await readFile(preflightCachePath(), "utf8"));
  assert.deepEqual(Object.keys(cache).sort(), ["checkedAt", "scopes", "version"]);
  assert.ok(!JSON.stringify(cache).includes("must-not-be-cached"));
  if (process.platform !== "win32")
    assert.equal((await stat(preflightCachePath())).mode & 0o777, 0o600);
  const before = await readFile(process.env.LARK_TEST_CALLS, "utf8");
  assert.equal((await checkLarkCli()).cached, true);
  assert.equal(await readFile(process.env.LARK_TEST_CALLS, "utf8"), before);
  assert.equal((await readPreflightCache()).checkedAt, cache.checkedAt);
  assert.equal((await checkLarkCli(true)).cached, false);
  const afterForce = await readFile(process.env.LARK_TEST_CALLS, "utf8");
  assert.notEqual(afterForce, before);
  await invalidatePreflightCache();
  assert.equal(await readPreflightCache(), undefined);
  assert.equal(await readFile(process.env.LARK_TEST_CALLS, "utf8"), afterForce);
  await writeFile(
    preflightCachePath(),
    JSON.stringify({ ...cache, checkedAt: Date.now() - CACHE_TTL_MS - 1 }),
  );
  assert.equal((await checkLarkCli()).cached, false);
  await writeFile(
    preflightCachePath(),
    JSON.stringify({ ...cache, checkedAt: Date.now() + CACHE_TTL_MS }),
  );
  assert.equal(await readPreflightCache(), undefined);
  await writeFile(preflightCachePath(), "not json");
  assert.equal((await checkLarkCli()).cached, false);
  await writeFile(preflightCachePath(), JSON.stringify({ ...cache, scopes: [] }));
  assert.equal(await readPreflightCache(), undefined);
  await checkLarkCli();
  process.env.LARK_TEST_EXIT = "3";
  assert.equal((await checkLarkCli(true)).status, "needs-auth");
  assert.equal(await readPreflightCache(), undefined);
  process.env.LARK_TEST_EXIT = "4";
  const failed = await checkLarkCli();
  assert.equal(failed.status, "error");
  assert.match(failed.message, /授权检查失败或超时/);
  process.env.LARK_TEST_EXIT = "0";
  process.env.LARK_TEST_STATUS = "not json";
  assert.equal((await checkLarkCli()).status, "error");
  assert.equal(await readPreflightCache(), undefined);
  process.env.LARK_TEST_STATUS = JSON.stringify({ identities: { user } });
  await checkLarkCli();
  const cleared = JSON.parse(
    (await exec(process.execPath, ["--experimental-strip-types", script, "--invalidate"])).stdout,
  );
  assert.equal(cleared.status, "invalidated");
  assert.equal(await readPreflightCache(), undefined);
  assert.ok(
    (await readFile(process.env.LARK_TEST_CALLS, "utf8"))
      .trim()
      .split("\n")
      .every((line) => {
        assert.deepEqual(JSON.parse(line), ["auth", "status", "--json", "--verify"]);
        return true;
      }),
  );
});

test("Lark creation validates parents and stops safely after partial success or cancellation", async (t) => {
  const root = await sandbox(t, "lark-create-", [
    "PATH",
    "LARK_TEST_CALLS",
    "LARK_TEST_FAIL",
    "LARK_TEST_FIELDS",
  ]);
  const parent = "https://example.feishu.cn/wiki/parent123?table=ignored&view=ignored";
  const template = JSON.parse(
    await readFile(
      new URL(
        "../skills/gkd-workloop/integrations/lark/assets/issue-tracker.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  process.env.PATH = root;
  process.env.LARK_TEST_CALLS = join(root, "calls.ndjson");
  process.env.LARK_TEST_FIELDS = JSON.stringify(template.fields);
  delete process.env.LARK_TEST_FAIL;
  await writeFile(
    join(root, "lark-cli"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
fs.appendFileSync(process.env.LARK_TEST_CALLS, JSON.stringify(args) + "\\n");
if (process.env.LARK_TEST_FAIL === "malformed") { process.stdout.write("secret-must-not-leak"); process.exit(0); }
if (args[1] === process.env.LARK_TEST_FAIL) {
  process.stderr.write(JSON.stringify({ok:false,error:{code:99991679,missing_scopes:["base:record:create"],message:"secret-must-not-leak"}}));
  process.exit(3);
}
let data = {};
if (args[1] === "+node-get") data = value("--node-token").startsWith("https:")
  ? {node_token:"parent123",space_id:"123456"}
  : {node_token:"newNode",parent_node_token:"parent123",obj_token:"newBase",obj_type:"bitable"};
if (args[1] === "+base-create") data = {base:{base_token:"newBase"},table:{id:"tblNew"}};
if (args[1] === "+move") data = {ready:process.env.LARK_TEST_FAIL !== "pending-move",node_token:"newNode"};
if (args[1] === "+view-list") data = {total:1,views:[{id:"vewDefault",type:"grid"}]};
if (args[1] === "+table-get") data = {fields:JSON.parse(process.env.LARK_TEST_FIELDS)};
if (args[1] === "+record-batch-create") data = {record_id_list:["recExample"]};
process.stdout.write(JSON.stringify({ok:true,identity:"user",data}));
`,
    { mode: 0o700 },
  );
  const invalidParents = [
    "not-url",
    "http://example.feishu.cn/wiki/token",
    "https://feishu.cn.evil.com/wiki/token",
    "https://u:p@example.feishu.cn/wiki/token",
    "https://example.feishu.cn/docx/token",
  ];
  for (const input of ["", ...invalidParents]) {
    await assert.rejects(createTracker(input), /创建未开始.*知识库（Wiki）父页面链接/);
  }
  await assert.rejects(readFile(process.env.LARK_TEST_CALLS), { code: "ENOENT" });
  // Internal table creation has no standalone shortcut; preserve its script contract.
  const script = fileURLToPath(
    new URL("../skills/gkd-workloop/integrations/lark/scripts/create.ts", import.meta.url),
  );
  const result = JSON.parse(
    (await exec(process.execPath, ["--experimental-strip-types", script, parent])).stdout,
  );
  assert.equal(result.status, "created");
  assert.equal(result.url, "https://example.feishu.cn/wiki/newNode");
  const calls = (await readFile(process.env.LARK_TEST_CALLS, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(calls.filter((args) => args[1] === "+base-create").length, 1);
  const create = calls.find((args) => args[1] === "+base-create");
  assert.deepEqual(JSON.parse(create[create.indexOf("--fields") + 1]), template.fields);
  assert.ok(calls.every((args) => args.includes("user") && !args.includes("--yes")));
  assert.ok(
    !calls.some(
      (args) =>
        args[0] === "auth" ||
        args[1] === "+form-create" ||
        /copy|delete/.test(args[1]) ||
        (args[1].includes("record") && args[1] !== "+record-batch-create"),
    ),
  );
  const seeds = calls.filter((args) => args[1] === "+record-batch-create");
  assert.equal(seeds.length, 1);
  assert.equal(calls.at(-1), seeds[0]);
  assert.deepEqual(JSON.parse(seeds[0][seeds[0].indexOf("--json") + 1]), {
    create_records: template.records,
  });
  const move = calls.find((args) => args[1] === "+move");
  assert.equal(move[move.indexOf("--target-parent-token") + 1], "parent123");
  assert.deepEqual(
    calls
      .filter((args) => args[1] === "+view-set-group")
      .map((args) => JSON.parse(args[args.indexOf("--json") + 1])),
    template.views.filter((view) => view.group).map((view) => ({ group_config: view.group })),
  );
  assert.deepEqual(
    calls
      .filter((args) => args[1] === "+view-set-visible-fields")
      .map((args) => JSON.parse(args[args.indexOf("--json") + 1]).visible_fields),
    template.views.map((view) => view.visibleFields),
  );
  process.env.LARK_TEST_FAIL = "+record-batch-create";
  await assert.rejects(createTracker(parent), (error) => {
    assert.match(error.message, /base:record:create/);
    assert.match(error.message, /已创建资源.*https:\/\/example.feishu.cn\/wiki\/newNode/);
    assert.match(error.message, /不要直接重跑/);
    assert.doesNotMatch(error.message, /secret-must-not-leak/);
    return true;
  });
  process.env.LARK_TEST_FAIL = "malformed";
  await assert.rejects(createTracker(parent), (error) => {
    assert.match(error.message, /不是有效 JSON/);
    assert.doesNotMatch(error.message, /secret-must-not-leak/);
    return true;
  });
  process.env.LARK_TEST_FAIL = "pending-move";
  await assert.rejects(createTracker(parent), /挂载尚未完成/);
  let allCalls = (await readFile(process.env.LARK_TEST_CALLS, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(allCalls.at(-1)[1], "+move");
  delete process.env.LARK_TEST_FAIL;
  let checks = 0;
  await assert.rejects(
    createTracker(parent, () => ++checks < 4),
    (error) => {
      assert.match(error.message, /会话或任务已变化/);
      assert.match(error.message, /https:\/\/example.feishu.cn\/base\/newBase/);
      return true;
    },
  );
  allCalls = (await readFile(process.env.LARK_TEST_CALLS, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(allCalls.at(-1)[1], "+base-create");
});

test("Lark bindings preserve confirmed associations and reject conflicts, corrupt data and unsafe paths", async (t) => {
  const root = await sandbox(t, "lark-bindings-", ["PI_CODING_AGENT_DIR"]);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const workspace = join(await realpath(root), "repo");
  for (const project of ["apps/web", "apps/admin", "apps/moved"])
    await mkdir(join(workspace, project), { recursive: true });
  const script = fileURLToPath(
    new URL("../skills/gkd-workloop/integrations/lark/scripts/bindings.ts", import.meta.url),
  );
  const cli = (input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        ["--experimental-strip-types", script],
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stderr }));
          else resolve(JSON.parse(stdout));
        },
      );
      child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    });
  let current = await cli({ action: "read" });
  assert.equal(current.status, "ready");
  assert.deepEqual(current.bindings, []);
  await assert.rejects(stat(bindingsPath()), { code: "ENOENT" });
  const binding = {
    baseToken: "baseA",
    tableId: "tblA",
    workspace,
    project: "apps/web",
    source: "inferred",
    evidence: "apps/web/package.json 与实际路由确认归属",
  };
  const emptyRevision = current.revision;
  current = await cli({ action: "save", expectedRevision: current.revision, binding });
  assert.equal(current.status, "saved");
  assert.equal(current.bindings.length, 1);
  const webId = current.bindings[0].id;
  assert.equal(current.bindings[0].workspace, workspace);
  assert.equal(current.bindings[0].project, "apps/web");
  assert.ok(Number.isFinite(current.bindings[0].updatedAt));
  if (process.platform !== "win32") assert.equal((await stat(bindingsPath())).mode & 0o777, 0o600);
  current = await manageBindings({
    action: "save",
    expectedRevision: current.revision,
    binding: { ...binding, evidence: "新增调用链证据" },
  });
  assert.equal(current.bindings.length, 1);
  assert.equal(current.bindings[0].id, webId);
  current = await manageBindings({
    action: "save",
    expectedRevision: current.revision,
    binding: { ...binding, project: "apps/admin" },
  });
  const adminId = current.bindings[1].id;
  current = await manageBindings({
    action: "save",
    expectedRevision: current.revision,
    binding: { ...binding, tableId: "tblB" },
  });
  assert.equal(current.bindings.length, 3);
  current = await manageBindings({
    action: "save",
    expectedRevision: current.revision,
    binding: {
      ...binding,
      id: webId,
      project: "apps/moved",
      source: "user",
      evidence: "用户确认项目已迁移",
    },
  });
  assert.equal(current.bindings.length, 3);
  assert.equal(current.bindings.find((item) => item.id === adminId).project, "apps/admin");
  assert.equal(current.bindings.find((item) => item.id === webId).source, "user");
  // 同键保存和按 id 迁移均不能将人工确认的关联降级为自动推断。
  for (const inferred of [
    { ...binding, project: "apps/moved", evidence: "自动推断" },
    { ...binding, id: webId, project: "apps/moved", evidence: "自动推断" },
  ]) {
    await assert.rejects(
      manageBindings({
        action: "save",
        expectedRevision: current.revision,
        binding: inferred,
      }),
      /用户确认.*不能用自动推断覆盖/,
    );
  }
  assert.equal((await manageBindings({ action: "read" })).revision, current.revision);
  current = await manageBindings({
    action: "save",
    expectedRevision: current.revision,
    binding: {
      ...binding,
      id: webId,
      project: "apps/moved",
      source: "user",
      evidence: "用户再次确认项目归属",
    },
  });
  assert.equal(current.bindings.find((item) => item.id === webId).source, "user");
  const before = await readFile(bindingsPath(), "utf8");
  await assert.rejects(
    manageBindings({ action: "save", expectedRevision: emptyRevision, binding }),
    /绑定已变化/,
  );
  for (const invalid of [
    { ...binding, workspace: "relative" },
    { ...binding, project: "../outside" },
    { ...binding, project: workspace },
    { ...binding, workspace: join(root, "missing") },
    { ...binding, evidence: " " },
    { ...binding, tableId: "wikiToken" },
    { ...binding, source: "guessed" },
  ]) {
    await assert.rejects(
      manageBindings({ action: "save", expectedRevision: current.revision, binding: invalid }),
      /保存未开始/,
    );
  }
  await writeFile(join(workspace, "not-directory"), "text");
  await assert.rejects(
    manageBindings({
      action: "save",
      expectedRevision: current.revision,
      binding: { ...binding, project: "not-directory" },
    }),
    /目录/,
  );
  if (process.platform !== "win32") {
    await symlink(await realpath(root), join(workspace, "outside"), "dir");
    await assert.rejects(
      manageBindings({
        action: "save",
        expectedRevision: current.revision,
        binding: { ...binding, project: "outside" },
      }),
      /越出工作区/,
    );
  }
  await assert.rejects(
    manageBindings({
      action: "save",
      expectedRevision: current.revision,
      binding: { ...binding, id: webId, tableId: "tblOther" },
    }),
    /另一张表/,
  );
  await assert.rejects(
    manageBindings({
      action: "save",
      expectedRevision: current.revision,
      binding: { ...binding, id: webId, project: "apps/admin" },
    }),
    /关联已存在/,
  );
  await assert.rejects(manageBindings({ action: "remove", id: webId }), /expectedRevision/);
  await writeFile(`${bindingsPath()}.lock`, "");
  await assert.rejects(
    manageBindings({ action: "save", expectedRevision: current.revision, binding }),
    /绑定正在更新/,
  );
  await rm(`${bindingsPath()}.lock`);
  assert.equal(await readFile(bindingsPath(), "utf8"), before);
  const results = await Promise.allSettled(
    ["first", "second"].map((evidence) =>
      manageBindings({
        action: "save",
        expectedRevision: current.revision,
        binding: { ...binding, evidence },
      }),
    ),
  );
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  current = await manageBindings({ action: "read" });
  assert.equal(current.bindings.length, 4);
  await rm(join(workspace, "apps/moved"), { recursive: true });
  current = await manageBindings({
    action: "remove",
    expectedRevision: current.revision,
    id: webId,
  });
  assert.equal(current.status, "removed");
  assert.ok(!current.bindings.some((item) => item.id === webId));
  assert.ok(current.bindings.some((item) => item.id === adminId));
  await assert.rejects(
    manageBindings({ action: "remove", expectedRevision: current.revision, id: "missing" }),
    /原绑定不存在/,
  );
  const preflight = fileURLToPath(
    new URL("../skills/gkd-workloop/integrations/lark/scripts/preflight.ts", import.meta.url),
  );
  await exec(process.execPath, ["--experimental-strip-types", preflight, "--invalidate"]);
  assert.equal((await manageBindings({ action: "read" })).revision, current.revision);
  assert.deepEqual(await readdir(join(root, "agent", "lark-workloop")), [
    "workspace-bindings.json",
  ]);
  await assert.rejects(cli("not-json private-request"), (error) => {
    assert.match(error.stderr, /stdin 必须为有效 JSON/);
    assert.doesNotMatch(error.stderr, /private-request|SyntaxError|at main/);
    return true;
  });
  for (const content of [
    "not-json",
    JSON.stringify({ version: 2, bindings: [] }),
    JSON.stringify({ version: 1, bindings: [current.bindings[0], current.bindings[0]] }),
  ]) {
    await writeFile(bindingsPath(), content);
    await assert.rejects(
      manageBindings({ action: "save", expectedRevision: current.revision, binding }),
      /损坏|格式不兼容/,
    );
    assert.equal(await readFile(bindingsPath(), "utf8"), content);
  }
  await rm(bindingsPath());
  await mkdir(bindingsPath());
  await assert.rejects(cli({ action: "read" }), (error) => {
    assert.match(error.stderr, /个人数据目录权限/);
    assert.doesNotMatch(error.stderr, /EISDIR|stack|private-request/);
    return true;
  });
});
