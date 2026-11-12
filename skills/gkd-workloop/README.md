# GKD Workloop

Skill 是主体：分流、计划审批、开发、验证、恢复和飞书处理均由 `SKILL.md` 与本目录资源定义。使用宿主 Agent 的原生工具，不需要 Pi 插件或任何 Pi 专属工具。

## 独立安装

将整个 `skills/gkd-workloop/` 目录复制到目标 Agent 支持的 Skill 搜索路径，目录名保持 `gkd-workloop`。保留 `references/`、`integrations/`、`agents/` 等所有内容，不要只复制 `SKILL.md`。

例如采用 Agent Skills 目录约定的宿主可安装至 `~/.agents/skills/gkd-workloop/`；Claude Code 可按其 Skill 配置安装至 `~/.claude/skills/gkd-workloop/`。具体搜索路径和调用语法以目标 Agent 的配置为准，本项目不额外实现各平台安装器。

- 普通开发需要本地读写、搜索、命令和用户交互能力。
- 飞书操作额外需要 Node.js >= 22.19.0 与官方 `lark-cli` 的应用配置及用户授权。现有 lark-* Skill 是可选辅助，不是独立安装的必需依赖。
- 所有资源都在本目录内；脚本只导入 Node.js 标准库和目录内文件，不需要仓库根目录的 `node_modules`。

## Pi 体验增强

仓库的 `package.json` 同时声明本 Skill 和 `extensions/gkd-workflow/index.ts`。Pi 插件只提供：

- `/gkd-workloop <请求>`：检查当前是否空闲、接入 Model Probe 门禁、隐藏传递 cwd，原样交给 `/skill:gkd-workloop`。
- `/gkd-settings` 和 `Cmd+Shift+G`：全局自动加载 Skill 开关，默认关闭；开启后普通用户输入加载同一份 Skill，不改原消息或附件。

自动开关不批准、恢复或取消任务。插件不提供强制开发状态机、阶段工具权限、额外分类模型、任务持久化或自动重试。只安装 Skill 仍可完成相同流程。

## 从旧版迁移

- 原 `extensions/gkd-workflow/gkd-workloop/` 和旁边的飞书资源已合并到本目录，更新手工配置的 Skill 路径。
- 删除旧的状态机与分类调试命令；审批、阶段和恢复改由 Skill 协议约束，不再是插件级门禁或权限沙箱。
- 旧任务状态文件不迁移、不删除、不自动恢复，也不沿用旧审批。升级前保留任务交接和本地改动；升级后重新打开会话或 `/reload`，显式说明待继续任务，重新核对计划与实际工作区。旧会话若还包含旧版工具指令，优先使用新会话，避免混用。
- Pi 自动开关配置保留原路径。飞书缓存与绑定继续使用 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lark-workloop/`，兼容已有数据；这不要求其他 Agent 安装 Pi。

协议是否被遵守仍依赖当前 Agent 与宿主权限系统。离线资源/脚本测试不能证明 Codex、Claude Code 等真实模型会正确执行审批与验收；跨宿主行为需另行验证。
