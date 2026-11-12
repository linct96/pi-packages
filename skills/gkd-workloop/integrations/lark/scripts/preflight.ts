import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REQUIRED_SCOPES = [
  "base:app:read",
  "base:block:read",
  "base:table:read",
  "base:field:read",
  "base:view:read",
  "base:record:read",
  "base:record:update",
  "wiki:node:read",
  "sheets:spreadsheet.meta:read",
  "sheets:spreadsheet:read",
  "drive:file:download",
];

const exec = promisify(execFile);
type PreflightResult =
  | { status: "ready"; cached: boolean; checkedAt: number; expiresAt: number }
  | { status: "missing-cli" | "error"; message: string }
  | { status: "needs-auth"; message: string; missingScopes: string[] };

// 只接受 JSON 对象，避免把异常输出当作授权成功。
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 保留历史数据目录以兼容已有缓存；独立 Skill 不依赖 Pi 运行时。
export function preflightCachePath() {
  return join(
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    "lark-workloop",
    "preflight.json",
  );
}

// 仅复用一周内且覆盖当前基础权限集的成功检查，拒绝未来时间戳。
export async function readPreflightCache(): Promise<
  Extract<PreflightResult, { status: "ready" }> | undefined
> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(preflightCachePath(), "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && error.code === "ENOENT")) return;
    throw new Error("无法读取 lark-workloop 检查缓存，请检查个人数据目录权限。");
  }
  const scopes = isRecord(value) ? value.scopes : undefined;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.checkedAt !== "number" ||
    !Number.isFinite(value.checkedAt) ||
    value.checkedAt > Date.now() ||
    Date.now() - value.checkedAt >= CACHE_TTL_MS ||
    !Array.isArray(scopes) ||
    !REQUIRED_SCOPES.every((scope) => scopes.includes(scope))
  )
    return;
  return {
    status: "ready",
    cached: true,
    checkedAt: value.checkedAt,
    expiresAt: value.checkedAt + CACHE_TTL_MS,
  };
}

// 提前撤销旧的成功结果，失败检查不能继续沿用它。
export async function invalidatePreflightCache() {
  await rm(preflightCachePath(), { force: true });
}

// 原子保存已验证时间与基础权限集，不存 token、密钥、授权链接或设备码。
async function savePreflightCache(checkedAt: number) {
  const path = preflightCachePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, checkedAt, scopes: REQUIRED_SCOPES }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// 返回需要补齐的用户授权，让 agent 按飞书分步授权流程交还控制权。
function needsAuth(missingScopes = [...REQUIRED_SCOPES]): PreflightResult {
  return {
    status: "needs-auth",
    message:
      "lark-cli 用户授权未就绪或缺少基础权限。请按宿主已有 lark-shared 或 lark-cli 授权帮助完成必要的应用配置和用户授权，再强制复检；不能使用 bot 身份代替。",
    missingScopes,
  };
}

// 优先读缓存；过期或强制复检时才调用 CLI 并向服务端验证用户登录。
export async function checkLarkCli(force = false): Promise<PreflightResult> {
  if (!force) {
    const cached = await readPreflightCache();
    if (cached) return cached;
  }
  await invalidatePreflightCache();
  let stdout: string;
  try {
    ({ stdout } = await exec("lark-cli", ["auth", "status", "--json", "--verify"], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    }));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return {
        status: "missing-cli",
        message:
          "未检测到 lark-cli，请先按官方文档安装并确保命令位于 PATH：https://github.com/larksuite/cli 。安装后重新请求检查飞书授权；Skill 不会自动安装。",
      };
    }
    if (isRecord(error) && error.code === 3) return needsAuth();
    return {
      status: "error",
      message:
        "lark-cli 授权检查失败或超时，未缓存成功结果。请检查 CLI 配置与网络后重试；不会输出可能包含凭据的原始诊断。",
    };
  }
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return {
      status: "error",
      message: "lark-cli 返回的授权状态不是有效 JSON，请检查 CLI 版本与配置。",
    };
  }
  if (!isRecord(status) || status.ok === false || !isRecord(status.identities)) {
    return {
      status: "error",
      message: "无法识别 lark-cli 用户授权状态，未缓存成功结果，请检查 CLI 版本与配置。",
    };
  }
  const user = status.identities.user;
  if (!isRecord(user) || user.status !== "ready" || user.verified !== true) return needsAuth();
  const granted = new Set(typeof user.scope === "string" ? user.scope.split(/\s+/) : []);
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length) return needsAuth(missing);
  const checkedAt = Date.now();
  await savePreflightCache(checkedAt);
  return { status: "ready", cached: false, checkedAt, expiresAt: checkedAt + CACHE_TTL_MS };
}

// 提供其他 agent 可直接运行的入口，与快捷命令共享缓存和检查规则。
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some((arg) => arg !== "--force" && arg !== "--invalidate")) {
    throw new Error("用法：node --experimental-strip-types preflight.ts [--force | --invalidate]");
  }
  if (args[0] === "--invalidate") {
    await invalidatePreflightCache();
    console.log(JSON.stringify({ status: "invalidated" }));
    return;
  }
  const result = await checkLarkCli(args[0] === "--force");
  console.log(JSON.stringify(result));
  if (result.status !== "ready") process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        status: "error",
        message: "前置检查未完成，请检查 CLI 和缓存目录权限；未启动问题处理。",
      }),
    );
    process.exitCode = 1;
  });
}
