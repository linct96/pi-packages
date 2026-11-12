import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

type ObjectValue = Record<string, unknown>;
type TrackerTemplate = {
  tableName: string;
  fields: (ObjectValue & { name: string; type: string })[];
  records: ObjectValue[];
  views: {
    name: string;
    type: string;
    group?: { field: string; desc: boolean }[];
    visibleFields: string[];
  }[];
};
const exec = promisify(execFile);

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLI 返回了无法识别的对象。");
  }
  return value as ObjectValue;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9]+$/.test(value)) {
    throw new Error("CLI 未返回有效资源 ID。");
  }
  return value;
}

export async function createTracker(
  parentUrl: string,
  isCurrent = () => true,
  onProgress: (stage: string) => void = () => {},
) {
  const invalidParentMessage =
    "创建未开始：需要飞书/Lark 知识库（Wiki）父页面链接。\n请打开要放置新表的知识库页面，复制地址栏中含 /wiki/ 的 HTTPS 链接；不支持云盘文件夹或普通文档链接。\n用法：/gkd-workloop create-lark-table <Wiki 父页面链接>";
  let parent: URL;
  try {
    parent = new URL(parentUrl);
  } catch {
    throw new Error(invalidParentMessage);
  }
  if (
    parent.protocol !== "https:" ||
    !/(^|\.)(feishu\.cn|larkoffice\.com|larksuite\.com)$/.test(parent.hostname) ||
    parent.username ||
    parent.password ||
    parent.port ||
    !/^\/wiki\/[a-zA-Z0-9]+\/?$/.test(parent.pathname)
  ) {
    throw new Error(invalidParentMessage);
  }
  // 只读取本地结构，不在每次创建时访问模板或读取真实漏洞。
  const template = JSON.parse(
    await readFile(new URL("../assets/issue-tracker.json", import.meta.url), "utf8"),
  ) as TrackerTemplate;
  let stage = "解析父页面";
  let url = "";
  let writeStarted = false;
  async function cli(args: string[]): Promise<ObjectValue> {
    if (!isCurrent()) throw new Error("会话或任务已变化，已停止后续操作。");
    onProgress(stage);
    let stdout: string;
    try {
      ({ stdout } = await exec("lark-cli", [...args, "--as", "user", "--format", "json"], {
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
        },
      }));
    } catch (error) {
      const failure = object(error);
      if (failure.code === "ENOENT") throw new Error("未检测到 lark-cli，请先安装并加入 PATH。");
      let detail: ObjectValue = {};
      try {
        detail = object(object(JSON.parse(String(failure.stderr))).error);
      } catch {
        /* 不回显可能包含凭据的原始诊断。 */
      }
      const scopes = Array.isArray(detail.missing_scopes)
        ? detail.missing_scopes.filter(
            (scope) => typeof scope === "string" && /^[a-z0-9_:.-]+$/.test(scope),
          )
        : [];
      throw new Error(
        `lark-cli 调用失败或超时${typeof detail.code === "number" ? `（${detail.code}）` : ""}。` +
          (scopes.length
            ? `缺少权限：${scopes.join(" ")}；请按宿主已有 lark-shared 或 lark-cli 授权帮助补充用户授权。`
            : "请检查用户授权、资源访问权限与网络。") +
          (failure.code === 10 ? "高风险确认门禁未通过，未自动追加 --yes。" : ""),
      );
    }
    let result: ObjectValue;
    try {
      result = object(JSON.parse(stdout));
    } catch {
      throw new Error("CLI 返回的结果不是有效 JSON 对象。");
    }
    if (result.ok !== true || result.identity !== "user") {
      throw new Error("CLI 未确认用户身份下操作成功。");
    }
    return object(result.data);
  }
  try {
    const target = await cli(["wiki", "+node-get", "--node-token", parent.href]);
    const parentToken = id(target.node_token);
    const spaceId = id(target.space_id);
    stage = "创建漏洞跟踪表";
    if (!isCurrent()) throw new Error("会话或任务已变化，已停止后续操作。");
    writeStarted = true;
    const created = await cli([
      "base",
      "+base-create",
      "--name",
      template.tableName,
      "--table-name",
      template.tableName,
      "--fields",
      JSON.stringify(template.fields),
    ]);
    const base = object(created.base);
    const baseToken = id(base.base_token ?? base.app_token);
    url = `${parent.origin}/base/${baseToken}`;
    const table = object(created.table);
    const tableId = id(table.id ?? table.table_id);
    stage = "挂载到父页面";
    const moved = await cli([
      "wiki",
      "+move",
      "--obj-type",
      "bitable",
      "--obj-token",
      baseToken,
      "--target-space-id",
      spaceId,
      "--target-parent-token",
      parentToken,
    ]);
    if (moved.ready !== true) throw new Error("挂载尚未完成，请先核对知识库，勿重新创建。");
    const nodeToken = id(moved.node_token);
    url = `${parent.origin}/wiki/${nodeToken}`;
    const tableArgs = ["--base-token", baseToken, "--table-id", tableId];
    stage = "配置视图";
    const current = await cli(["base", "+view-list", ...tableArgs]);
    const views = Array.isArray(current.views) ? current.views.map(object) : [];
    if (current.total !== 1 || views.length !== 1 || views[0].type !== "grid") {
      throw new Error("新表默认视图不唯一或类型异常，未修改已有视图。");
    }
    await cli([
      "base",
      "+view-rename",
      ...tableArgs,
      "--view-id",
      id(views[0].id),
      "--name",
      template.views[0].name,
    ]);
    await cli([
      "base",
      "+view-create",
      ...tableArgs,
      "--json",
      JSON.stringify(template.views.slice(1).map(({ name, type }) => ({ name, type }))),
    ]);
    for (const view of template.views) {
      const viewArgs = [...tableArgs, "--view-id", view.name];
      if (view.group) {
        await cli([
          "base",
          "+view-set-group",
          ...viewArgs,
          "--json",
          JSON.stringify({ group_config: view.group }),
        ]);
      }
      await cli([
        "base",
        "+view-set-visible-fields",
        ...viewArgs,
        "--json",
        JSON.stringify({ visible_fields: view.visibleFields }),
      ]);
    }
    stage = "核对字段与挂载位置";
    const actual = await cli(["base", "+table-get", ...tableArgs]);
    const fields = Array.isArray(actual.fields) ? actual.fields.map(object) : [];
    if (
      fields.length !== template.fields.length ||
      !template.fields.every((expected) =>
        fields.some((field) => field.name === expected.name && field.type === expected.type),
      )
    )
      throw new Error("新表字段与本地模板不一致。");
    const node = await cli(["wiki", "+node-get", "--node-token", nodeToken]);
    if (
      node.parent_node_token !== parentToken ||
      node.obj_token !== baseToken ||
      node.obj_type !== "bitable"
    ) {
      throw new Error("新页面的父节点或对象类型与预期不一致。");
    }
    stage = "添加示例数据";
    const seeded = await cli([
      "base",
      "+record-batch-create",
      ...tableArgs,
      "--json",
      JSON.stringify({ create_records: template.records }),
    ]);
    if (
      !Array.isArray(seeded.record_id_list) ||
      seeded.record_id_list.length !== template.records.length
    ) {
      throw new Error("CLI 未确认示例数据已全部创建。");
    }
    return {
      status: "created" as const,
      url,
      baseToken,
      tableId,
    };
  } catch (error) {
    throw new Error(
      `${stage}未完成：${error instanceof Error ? error.message : "未知错误"}` +
        (url ? `\n已创建资源（可能未配置完整）：${url}` : "") +
        (writeStarted
          ? "\n写入可能已生效；请先核对现有资源，不要直接重跑 create，以免重复创建。"
          : ""),
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error("用法：node --experimental-strip-types create.ts <Wiki 父页面 URL>");
  console.log(JSON.stringify(await createTracker(args[0])));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "error",
        message: error instanceof Error ? error.message : "创建未完成",
      }),
    );
    process.exitCode = 1;
  });
}
