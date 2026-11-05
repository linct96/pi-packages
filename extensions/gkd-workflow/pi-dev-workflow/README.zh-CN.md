# pi-dev-workflow v0.2.0

这是一个 **Pi Extension + Skill** 组合包，提供渐进式的 FAST / STANDARD 开发工作流。

## 一、渐进式启用（默认手动）

安装不会自动执行开发任务，也不会主动拦截日常聊天。

1. **安装后**：使用 `/develop <任务>` 显式启动，Agent 检查代码后决定 FAST / STANDARD。
2. **确认适用后**：使用 `/develop-settings` 打开设置，启用自动启动。
3. **启用自动后**：直接输入开发指令（如“修复表单校验 Bug”），插件识别开发意图后自动开启，Agent 进一步检查代码判断 FAST / STANDARD；无需 `/develop`。
4. **随时退出自动模式**：`/develop-settings auto off`。手动命令仍可用。

自动启动仅拦截**明确要求修改代码/开发功能的输入**，例如“修复按钮点击失败”、“实现 PR #123 中的需求”。“解释一下这段代码为什么报错”、“如何设计 PR 流程”等问答不会自动进入开发循环。意图识别保守，不保证识别所有自然语言表达，漏判时仍可手动 `/develop`。

自动模式**不会跳过 STANDARD 的人工方案审批**，也不会自动创建 PR/MR、推送、合并、部署。

## 二、安装

解压 `pi-dev-workflow.zip` 到一个固定目录，在父目录执行：

```bash
pi install ./pi-dev-workflow
```

在已有 Pi 会话执行 `/reload`，或重启 Pi。进入已信任的 Git 项目目录。Pi 的项目可信检查适用于手动和自动启动。

## 三、命令

```text
/develop 修复按钮禁用状态             # 手动启动，让 Agent 自动选模式
/develop --fast 修复表单校验问题      # 手动指定 FAST
/develop --standard 根据 PR #123 开发 # 手动指定 STANDARD
/develop --max=20 修复订阅解析问题    # 限制循环轮次

/develop-settings                    # 交互式打开插件设置（TUI/RPC）
/develop-settings auto on            # 全局开启自动启动
/develop-settings auto off           # 全局关闭自动启动
/develop-settings status             # 查看设置

/develop-status                      # 查看当前任务状态
/develop-approve                     # 审批 STANDARD 方案并恢复
/develop-stop                        # 停止自动续跑，不强制中断正在执行的工具
/develop-resume                      # 恢复已停止或阻塞的任务
```

**自动模式示例**：先执行 `/develop-settings auto on`，之后直接发送：

```text
修复 Button 组件 loading 状态切换异常。

根据 PR #123 实现功能，验证通过后更新 PR 正文。

解释一下 React 19 的 useOptimistic。   # 普通问答，不启动工作流
```

## 四、设置位置

插件自身的用户级设置文件是：

```text
~/.pi/agent/dev-workflow/settings.json
```

如设置了 `PI_CODING_AGENT_DIR`，则位于 `$PI_CODING_AGENT_DIR/dev-workflow/settings.json`。默认值：

```json
{
  "version": 1,
  "autoStart": false
}
```

这是**插件设置**，通过 `/develop-settings` 配置，并不在 Pi 内置 `/settings` 里增加条目。命令修改后立即生效。

## 五、FAST / STANDARD 的工作流

| 分支 | 处理方式 |
| --- | --- |
| FAST | 代码分析 → 小范围修改 → 验证 → 最多 4 轮，不要求 PR 或技术文档 |
| STANDARD | 读取已有 PR/MR → 代码分析 → 写技术实施计划 → **等待 `/develop-approve`** → 按步骤循环修改和验证 → 更新 PR/MR |

**模式由 Agent 在看过相关源码之后通过 `dev_workflow_report(kind="mode", ...)` 决定**；插件只判断消息是否是明确的开发指令，而不凭关键词直接确定 FAST / STANDARD。

当任务复杂度升高时，FAST 可升级 STANDARD；遇到危险操作、方案不明确、缺少权限或重复失败，应停止等待用户。STANDARD 没有已有 PR/MR 时，只能经用户允许后创建。

## 六、独立验证与状态

项目级验证配置：`<repo>/.pi/dev-workflow.config.json`，示例：

```json
{
  "validators": ["pnpm lint", "pnpm test", "pnpm build"],
  "validationTimeoutMs": 120000
}
```

填写实际支持的命令。独立验证器会使用 shell 执行命令，只在可信项目启用；请先检查命令是否安全。没有配置验证器时，完成状态为 `review_required`，**不是验证通过**。验证连续失败 3 次或达到最大轮次自动停止。

项目执行状态位于 `<repo>/.pi/dev-workflow/state.json`，建议加入 `.gitignore`。方案默认保留在 `docs/plans/`。暂停审批和执行状态写入磁盘，可以跨会话恢复，但不会自动替你批准方案。

## 七、边界与限制

- 自动意图识别是保守的规则式第一层分类，无法保证覆盖所有表达，也可能出现误判；执行前仍由 Agent 决定 FAST / STANDARD。
- 自动模式不会处理插件注入消息、斜杠命令、流中断/排队消息，或非可信项目。
- 如果已有执行中、待审批或阻塞任务，不会覆盖其状态并自动启动另一任务。
- 未在真实登录的 Pi + GitHub/GitLab 中完成端到端认证测试；建议先在独立 Git Worktree 验证。
- 读取/更新 PR/MR 需要用户已有的 `gh`、`glab` 或其他连接能力；此包不包含凭据管理，也不自动合并或推送。
- 关闭自动启动不会取消已经运行的任务；当前任务需另用 `/develop-stop` 停止。
