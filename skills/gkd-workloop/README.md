# GKD Workloop

GKD Workloop 是一个独立的开发工作流 Skill。它使用当前 Agent 的原生工具完成任务分流、计划审批、开发、验证，以及飞书问题表处理；不需要额外 Agent 或 Pi 专属工具。

## 安装

1. 将整个 `skills/gkd-workloop/` 目录复制到宿主支持的 Skill 目录，保留 `SKILL.md`、`references/`、`integrations/` 和 `agents/`。
2. 配置宿主的 Skill 搜索路径。常见目录为 `~/.agents/skills/gkd-workloop/`；Claude Code 可按其配置使用 `~/.claude/skills/gkd-workloop/`。
3. 在目标代码工作区启动 Agent，按宿主的 Skill 调用方式或自然语言使用。

只复制 `SKILL.md` 会丢失子流程和飞书脚本。本项目不提供跨宿主的安装器；实际调用语法以宿主为准。

## 常见用法

| 请求 | 处理方式 |
| --- | --- |
| 修复登录 Bug、实现功能 | 选择 FAST 或 STANDARD，完成开发与验证 |
| 处理飞书问题表 URL | 扫描授权记录，处理一批并回写结果 |
| `check-lark` | 检查飞书 CLI 与用户授权 |
| `check-lark --force` | 忽略缓存，重新检查授权 |
| `check-lark --invalidate` | 清除授权检查缓存 |
| `create-lark-table <Wiki 父页面 URL>` | 在 Wiki 下创建漏洞跟踪问题表 |
| 查看、更新或移除表与项目的绑定 | 管理本地关联 |

在 Pi 中可以使用 `/gkd-workloop <请求>`。只输入 `/gkd-workloop` 时显示用法，不自动开始任务。其他宿主可以直接提出同等自然语言请求。

详细执行步骤见 [SKILL.md](SKILL.md)。

## 运行要求

- **普通开发**：Agent 需要文件读写、搜索、命令执行和用户交互能力。
- **飞书操作**：额外安装 Node.js >= 22.19.0 和官方 [lark-cli](https://github.com/larksuite/cli)，配置应用并完成用户授权。
- **脚本依赖**：飞书脚本仅使用 Node.js 标准库和 Skill 内资源，不依赖仓库根目录的 `node_modules`。
- **可选能力**：宿主的 `lark-*` Skills 可辅助确认接口，未安装时通过 `lark-cli --help` 核对。

## Pi 集成

仓库的 `package.json` 同时安装 Skill 和 `extensions/gkd-workflow/index.ts`。Pi 插件仅提供两个快捷功能：

1. `/gkd-workloop <请求>`：检查当前是否空闲，接入 Model Probe 门禁，并将当前会话 `cwd` 传递给 `/skill:gkd-workloop`。
2. `/gkd-settings` 或 `Cmd+Shift+G`：控制自动加载 Skill，默认关闭；开启后自动加载相同的 Skill，不修改原始消息和附件。

插件不会自动批准、恢复、取消或重试任务，也不提供独立状态机、额外分类模型或持久化任务控制器。只安装 Skill 仍可运行完整流程。

## 从旧版升级

1. 将手工 Skill 路径从旧 `extensions/gkd-workflow/gkd-workloop/` 改为 `skills/gkd-workloop/`。
2. 重新打开 Agent 会话，或在 Pi 中执行 `/reload`。若旧会话保留了已删除的工具指令，优先创建新会话。
3. 对尚未完成的旧任务提供交接信息；重新检查工作区、变更和计划审批。**不要将旧状态文件当作有效授权，也不要自动重放旧任务**。

旧版插件级状态机、分类调试命令和权限门禁已移除。飞书缓存及关联仍保存在 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lark-workloop/`，不会自动迁移或删除；其他宿主不必安装 Pi。

## 使用边界

默认不会提交代码、推送、创建 PR/MR、部署或归档；这些动作需要用户明确授权。Skill 约束依赖当前 Agent 遵守，不能替代宿主的权限机制。脚本与离线测试通过不代表所有宿主都已完成真实审批、授权和验收验证。
