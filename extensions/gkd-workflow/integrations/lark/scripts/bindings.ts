import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { preflightCachePath } from "./preflight.ts";

type Binding = {
  id: string;
  baseToken: string;
  tableId: string;
  workspace: string;
  project: string;
  source: "inferred" | "user";
  evidence: string;
  updatedAt: number;
};
type Store = { version: 1; bindings: Binding[] };

class BindingError extends Error {}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function projectPath(value: unknown): value is string {
  return text(value) && !isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function validBinding(value: unknown): value is Binding {
  return (
    object(value) &&
    text(value.id) &&
    typeof value.baseToken === "string" &&
    /^[a-zA-Z0-9]{1,128}$/.test(value.baseToken) &&
    typeof value.tableId === "string" &&
    /^tbl[a-zA-Z0-9]{1,128}$/.test(value.tableId) &&
    text(value.workspace) &&
    isAbsolute(value.workspace) &&
    projectPath(value.project) &&
    (value.source === "inferred" || value.source === "user") &&
    text(value.evidence) &&
    value.evidence.length <= 2000 &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    value.updatedAt >= 0
  );
}

function targetKey(binding: Binding) {
  return JSON.stringify([binding.baseToken, binding.tableId, binding.workspace, binding.project]);
}

export function bindingsPath() {
  return join(dirname(preflightCachePath()), "workspace-bindings.json");
}

function revision(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function readStore() {
  let content = "";
  try {
    content = await readFile(bindingsPath(), "utf8");
  } catch (error) {
    if (!object(error) || error.code !== "ENOENT") throw error;
    return {
      content,
      store: { version: 1, bindings: [] } satisfies Store,
      revision: revision(content),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new BindingError("绑定文件损坏：请保留原文件并人工修复，不会覆盖为默认配置。");
  }
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.bindings) ||
    !value.bindings.every(validBinding) ||
    new Set(value.bindings.map((item) => item.id)).size !== value.bindings.length ||
    new Set(value.bindings.map(targetKey)).size !== value.bindings.length
  ) {
    throw new BindingError("绑定文件格式不兼容或存在重复记录：请核对后重试，原文件未修改。");
  }
  return { content, store: value as Store, revision: revision(content) };
}

async function canonicalBinding(value: unknown): Promise<Binding> {
  if (!object(value)) throw new BindingError("保存未开始：缺少 binding 对象。");
  const binding = {
    ...value,
    id: value.id ?? randomUUID(),
    project: value.project ?? ".",
    updatedAt: Date.now(),
  };
  if (!validBinding(binding)) {
    throw new BindingError(
      "保存未开始：请提供真实 Base/Table ID、绝对工作区、相对子项目、来源及简短核实依据。",
    );
  }
  try {
    const workspace = await realpath(binding.workspace);
    const project = await realpath(resolve(workspace, binding.project));
    const path = relative(workspace, project);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
      throw new BindingError("保存未开始：子项目真实路径越出工作区，不能保存该绑定。");
    }
    if (!(await stat(workspace)).isDirectory() || !(await stat(project)).isDirectory()) {
      throw new BindingError("保存未开始：工作区和子项目必须是已存在的目录。");
    }
    return {
      id: binding.id,
      baseToken: binding.baseToken,
      tableId: binding.tableId,
      workspace,
      project: path || ".",
      source: binding.source,
      evidence: binding.evidence,
      updatedAt: binding.updatedAt,
    };
  } catch (error) {
    if (error instanceof BindingError) throw error;
    throw new BindingError("保存未开始：无法核实工作区或子项目目录，请检查路径及访问权限。");
  }
}

// 模型负责核实归属；这里只校验结构、路径和安全保存，不将业务输入当作执行授权。
export async function manageBindings(input: unknown) {
  if (
    !object(input) ||
    (input.action !== "read" && input.action !== "save" && input.action !== "remove")
  ) {
    throw new BindingError("绑定未开始：action 必须为 read、save 或 remove。");
  }
  if (input.action === "read") {
    const current = await readStore();
    return { ...current.store, status: "ready", revision: current.revision };
  }
  if (
    typeof input.expectedRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.expectedRevision)
  ) {
    throw new BindingError("绑定未开始：请先 read，再提供本次读取的 expectedRevision。");
  }
  const binding = input.action === "save" ? await canonicalBinding(input.binding) : undefined;
  if (input.action === "remove" && !text(input.id)) {
    throw new BindingError("移除未开始：请明确指定已有绑定 id。");
  }
  const path = bindingsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (object(error) && error.code === "EEXIST") {
      throw new BindingError(
        "绑定正在更新：请等待其他写入结束后重新读取；异常退出遗留锁需核对后人工清理。",
      );
    }
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await readStore();
    if (current.revision !== input.expectedRevision) {
      throw new BindingError("绑定已变化：请重新读取并核对，不会覆盖其他修改。");
    }
    const bindings = [...current.store.bindings];
    if (binding) {
      const suppliedId = object(input.binding) ? input.binding.id : undefined;
      const index = bindings.findIndex((item) =>
        suppliedId ? item.id === suppliedId : targetKey(item) === targetKey(binding),
      );
      if (suppliedId && index < 0)
        throw new BindingError("原绑定不存在：请重新读取后确认修改对象。");
      const previous = bindings[index];
      if (
        previous &&
        (previous.baseToken !== binding.baseToken || previous.tableId !== binding.tableId)
      ) {
        throw new BindingError("不能用已有 id 改绑到另一张表：请明确新增或移除对应关联。");
      }
      if (bindings.some((item, i) => i !== index && targetKey(item) === targetKey(binding))) {
        throw new BindingError("目标关联已存在：请核对后修改，不合并或覆盖其他关联。");
      }
      if (previous?.source === "user" && binding.source === "inferred") {
        throw new BindingError(
          "已有用户确认的项目关联：不能用自动推断覆盖，请保留原关联或让用户确认变更。",
        );
      }
      if (previous) bindings[index] = { ...binding, id: previous.id };
      else bindings.push(binding);
    } else {
      const index = bindings.findIndex((item) => item.id === input.id);
      if (index < 0) throw new BindingError("原绑定不存在：请重新读取后确认移除对象。");
      bindings.splice(index, 1);
    }
    const store = { ...current.store, bindings };
    const content = JSON.stringify(store, null, 2) + "\n";
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    if ((await readStore()).content !== current.content) {
      throw new BindingError("绑定保存期间发生变化：请重新读取并核对，未覆盖原文件。");
    }
    // shortcut: 外部编辑器仍可能与 rename 竞争；绑定文件应统一经本脚本写入。
    await rename(temporary, path);
    return { ...store, status: binding ? "saved" : "removed", revision: revision(content) };
  } finally {
    try {
      await rm(temporary, { force: true });
    } finally {
      try {
        await lock.close();
      } finally {
        await rm(lockPath);
      }
    }
  }
}

async function main() {
  if (process.argv.length > 2)
    throw new BindingError("用法：通过 stdin JSON 传入绑定操作，不接受命令行参数。");
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 65536) throw new BindingError("绑定请求过大：请只提交一个关联和简短依据。");
  }
  let request: unknown;
  try {
    request = JSON.parse(input);
  } catch {
    throw new BindingError("绑定未开始：stdin 必须为有效 JSON。");
  }
  console.log(JSON.stringify(await manageBindings(request)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        status: "error",
        message:
          error instanceof BindingError
            ? error.message
            : "绑定未完成：请检查个人数据目录权限并重新读取核对；不自动重放写入。",
      }),
    );
    process.exitCode = 1;
  });
}
