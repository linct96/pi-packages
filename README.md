# pi-packages

个人 Pi 扩展集合。当前使用单个 Pi Package，按功能组织扩展，无需构建或打包。

## 环境与开发

- Node.js >= 22.19.0
- pnpm 11.8.0（版本由 `package.json` 的 `packageManager` 固定）
- Pi；当前开发类型基于 `@earendil-works/pi-coding-agent@1.2.0`

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test

# 从仓库根目录临时加载整个包，不修改 Pi 配置
pi -e .
```

启动后输入 `/codex-setting` 打开 Codex 设置。修改扩展后执行 `/reload`。

只调试一个扩展时：

```bash
pi -e ./extensions/codex-setting/index.ts
```

`pnpm test` 使用 Node.js 内置测试运行器与 TypeScript 类型擦除，不依赖额外测试框架；部分 Node.js 版本会显示实验性类型擦除提示。

## Codex 设置

运行 `pi -e .` 后输入 `/codex-setting`，直接在 **Fast** 设置行切换，无需进入子菜单。

```text
Codex Settings

❯ Fast    off
```

Fast 沿用 Pi 原生设置列表的行内切换：

- `Space` / `Enter` 在 `off` 和 `on` 之间切换，立即应用到当前会话，不修改全局默认值。
- Fast 行显示当前会话值；下方 `Default: off/on` 显示已保存的全局默认值。
- `Ctrl+S` 将当前会话值保存为全局默认值，菜单保持打开。
- `Esc` 关闭菜单，不撤销已应用的切换。
- 保存期间切换及重复保存会被忽略；`Esc` 请求取消保存，结束后保留菜单与当前会话值。

菜单内快捷键沿用 Pi 的 `tui.select.*` 和 `app.models.save` 配置；如果你重绑了模型选择器的保存键，这里也会随之变化。

在主输入框按 `Cmd+Shift+F`（Pi 键名 `super+shift+f`）可直接切换当前会话的 Fast 开关，无需打开菜单；会显示 `Codex Fast: on/off` 提示，并同步底栏状态，不修改全局默认值，从后续请求起生效。该快捷键不通过原生 `keybindings.json` 配置。终端需支持上报 `super` 修饰键（通常通过 Kitty 键盘协议），且不能被终端自身的搜索等快捷键拦截；不支持时仍可使用 `/codex-setting`。

Fast 默认为 `off`。`on` 为当前选中的 `openai-codex` / `openai-codex-responses` 模型请求设置 `service_tier: "priority"`，不改变模型、推理强度或其他请求字段；`off` 不改写请求，不会清理其他配置或插件自行设置的 tier。不会改写其他 provider、不同模型或虚拟模型路由后的请求。

仅在 Fast 已启用且当前模型的 provider 为 `openai-codex`、API 为 `openai-codex-responses` 时，Pi 底部状态栏显示 `Codex Fast`；关闭或切换到其他模型时移除。切换模型、恢复会话和分支导航时同步显示状态；隐藏标记不会关闭 Fast，切回支持的 Codex 模型后自动恢复显示。该标记表示开关已开启，不表示服务端已确认 Priority；非 Codex 请求仍不受影响。使用原生扩展状态接口，不替换现有底栏；自定义底栏需支持显示扩展状态。

标记使用当前主题的 `dim` 色，与原生底栏一致，不写死 RGB，也不额外加粗或放大。字号和字体继承终端配置，Pi 插件不能单独设置。状态接口缓存已着色文字，切换 Pi 主题后执行 `/reload` 刷新标记颜色。

全局默认值独立保存在 `~/.pi/agent/codex-setting.json`（设置了 `PI_CODING_AGENT_DIR` 时使用该目录），不修改 Pi 的原生 `settings.json`。

保存保留临时文件加原子替换，并增加轻量冲突检测：

- 每次打开菜单读取磁盘默认值，保存时若 Fast 与打开时的默认值不同，提示重新打开菜单，不覆盖。
- 使用同目录 `codex-setting.json.lock` 排斥同时保存；遇到锁立即提示稍后重试，不阻塞菜单。正常结束、失败及取消均清理自己的锁和临时文件。
- 保存时保留其他配置字段，替换前再次检查文件内容，发现保存期间的外部修改则拒绝覆盖。配置损坏同样提示错误，不会静默覆盖。
- 锁约束使用本插件的写入进程，不能完全消除不遵守锁协议的外部编辑器在最后检查与替换之间的竞争。进程被强制结束可能残留锁；只有确认没有其他进程正在保存时，才能手动移除错误提示中的锁文件。

切换应用失败时显示 `Application failed`，设置行恢复原值，可再次按 `Space` / `Enter` 重试。保存失败时显示 `Save failed`，默认值标记不变，不撤销此前已应用的会话值；可再次保存重试。

菜单销毁、切换模型、会话退出/重载或分支导航会使旧菜单失效并取消未完成的保存；切换应用前还会复核会话和模型身份，过期结果不会修改新会话或刷新旧界面。取消会在文件操作和替换前检查，但无法撤销已经完成的原子替换；因此临界时刻取消可能已保存默认值。

当前会话的确认值记录在会话自定义条目中，重载/恢复会话和分支导航时恢复；没有该条目的新会话使用全局默认值。全局默认值同样适用于 print/RPC 等模式，但菜单仅在 TUI 模式可用。

Priority 的可用性、速度与实际计费由账号及服务端决定；不保证加速，Pi 展示的费用估算不能代替账单。

## gkd-workflow

- `/gkd <任务提示词>`：先调用主 Agent 的只读 `judge-route` 分类；分类成功后恢复正常工具，继续执行 DIRECT / FAST / STANDARD / NONE 对应流程。FAST / STANDARD 在产生可发布的改动且存在可用 GitHub / GitLab 远程仓库时，使用 `gkd-pr` Skill 生成 PR / MR。
- `/gkd-settings`：全局个人设置占位入口，暂无可配置项。
- `/gkd-judge-route <任务提示词>`：分流调试快捷入口，由当前主 Agent 只读调查并识别任务，不执行操作或开发、不创建计划或请求审批。

后续个人设置将跨项目、跨会话共用，不提供项目级或会话级覆盖。目前不预设设置项，不读写配置文件；具体设置菜单与全局持久化随首个设置项实现。`/gkd-settings` 目前仅显示通知，不调用模型；`/gkd` 则启动完整的分流与执行流程。

### 任务路由识别

分流是 **GKD 主 Agent 工作流中的一个阶段**，不是扩展内部的独立模型请求。分流模块位于 `extensions/gkd-workflow/judge-route/`：`policy.md` 描述分流原则、证据纪律和输出协议，`workflow.md` 描述主 Agent 的调查与提交步骤；`index.ts` 加载这两份指令，负责命令／工具注册、只读权限、结果校验及取消恢复。Markdown 按模块路径加载，不依赖待调查项目的工作目录；修改后执行 `/reload` 生效。`/gkd-judge-route` 仍仅供只读分流调试，不会执行任务；`/gkd` 在分类成功后才进入独立执行回合。默认不会拦截普通对话，必须手动使用 `/gkd` 启动。

使用 `/gkd-judge-route`，例如：

```text
/gkd-judge-route 提交 A 项目当前修改
/gkd-judge-route 修复按钮颜色错误
/gkd-judge-route 修改身份认证逻辑
/gkd-judge-route 解释 React useEffect
```

| 任务示例 | 预期路由 |
| --- | --- |
| 提交 A 项目已有修改 | DIRECT（执行前仍需核对项目、分支和差异） |
| 运行 A 项目现有测试并报告结果 | DIRECT |
| 强制推送或发布生产环境 | DIRECT（需要风险确认，不自动执行） |
| 修复按钮颜色错误并提交 | FAST（开发任务，提交只是收尾） |
| 解释如何提交代码 | NONE |
| 修复按钮颜色错误 | FAST |
| 修改单个组件的文案 | FAST |
| 重构规则集的数据模型 | STANDARD |
| 增加数据库迁移 | STANDARD |
| 修改身份认证逻辑 | STANDARD |
| 解释 React useEffect | NONE |
| 按现有格式统一三个页面的按钮文案，并逐页检查 | FAST（影响已确认、无行为协调） |
| 在两种状态管理方案中权衡后实施 | STANDARD |
| 在数据库、服务端和客户端分阶段切换协议 | STANDARD |
| 解释认证流程，不修改代码 | NONE |

判断遵循 **Task Route Policy v2.1**（JSON 结构仍为 2.0）。先判断任务性质：纯解释、咨询、讨论为 `non_development → NONE`；仅执行现成操作、不涉及实现变更为 `operation → DIRECT`；需要新增、修改或修复实现（包括混合操作的请求）为 `development → FAST / STANDARD`。DIRECT 根据任务内容判断，不根据用户指令的语气判断。

DIRECT 表示无需开发流程，不是执行授权：执行前仍需核对目标、范围和状态；缺少项目、分支等参数时在理由中记录待澄清，不升级成 STANDARD，也不把参数澄清当作风险审批。破坏性、对外发布或其他高风险操作仍需确认；执行中发现需要实现变更应重新按开发任务分流，不自行扩大任务范围。当前只做分类，尚无操作执行器或澄清／确认交互；证据工具可按需读取单文件差异和相关历史，但不提供完整的分支、工作区状态或外部环境核对，不得把 DIRECT 当作执行前检查已通过。

开发任务**默认 FAST，只有明确命中 STANDARD 触发条件才升级**。提示词分为决策原则、证据纪律和输出协议三部分，不依赖具体任务示例枚举。STANDARD 承担举证责任，必须说明具体触发项及任务或项目依据；不是要求 FAST 先证明五项条件全部成立。原有目标、实现、影响、低风险、验证五项内部字段仅保留观察含义，未知填 false，任意或全部为 false 都不单独升级。源码、调用方或测试资料缺失、尚未确定验证命令、低置信度也不单独升级；模型无触发项却提交 STANDARD，程序会归一化为 FAST。未知仍在理由中说明，FAST 不代表已验证安全或可以跳过执行前检查。

对于开发任务，架构/职责/边界变化、跨模块行为或契约协调、关键技术权衡、兼容性破坏、安全边界、数据迁移、无法安全地一次完成和验证的分阶段实施，以及经必要调查确认存在、会实质改变预期行为、方案或影响范围的重要未决问题，都触发 STANDARD。一般资料不足不属于这种重要不确定性；开发风险等级不能仅因无法证明低风险而填为 medium/high。多个文件的机械修改不等于跨模块协调；修改类型、数据模型或兼容地添加可选字段也不单独构成硬触发，需看语义、契约和风险。普通的查看、修改、测试步骤不等于分阶段实施。不能用文件数、代码行数或臆测的风险独立升级。

纯解释/咨询返回 NONE，不因出现认证、迁移等词语就成为开发任务；执行现成操作的请求不能归为 NONE。用户指定的模式只是偏好，不能替代 STANDARD 触发证据，也不能绕过已知风险的强制升级规则。发现关键证据缺失时明确记录缺什么，不编造源码、调用方或测试证据。与 BMAD 一样由主 Agent 执行工作流指令，但这里使用默认 FAST／明确触发才 STANDARD 的策略，不采用 BMAD 本地版本默认的代码行数阈值。`/gkd-judge-route` 不实现开发期间的 Loop、完成判定或持续升级；`/gkd` 执行阶段由主 Agent 按 `execute.md` 进行开发、验证、必要审批与发布，分类器本身保持只读。

命令通过 `pi.sendUserMessage()` 启动主 Agent 的原生回合，附加分流指令而不替换宿主原有系统提示词。任务、调查结果和分类都会进入当前会话上下文；这不是隔离的临时分类会话，已有对话也可能影响判断。模型请求、思考级别、取消、错误处理和用量记录均由 Pi 原生 Agent 循环负责，正常进入 Pi 会话 Token／费用统计，不重复上报 usage；费用仍取决于提供商报告和价格配置。

调试期间只开放两个确定性工具：`gkd_route_evidence` 按需查找路径、搜索内容、分段读取和查询 Git 历史，`gkd_judge_route` 接收主 Agent 给出的 JSON、校验后结束调试。主 Agent 自行调查，不调用嵌套模型，也不提供子 Agent 委派；其他工具（包括任意 shell、写入、测试和委派）仍被拦截。结束、取消或会话退出时恢复原工具集，退出会中止尚未完成的调查；未提交结果就停止时显示警告，不伪造分类。

分类 JSON 保存在原生工具结果中并在 TUI 展示。对于 `/gkd`，只有校验成功的分类才会交给下一个执行回合；分类错误、中止、取消或切换会话均不会触发执行或创建 PR/MR。成功结构包含 `schemaVersion: "2.0"`、`status: "ok"`、`intent`、`route`、`confidence`、`riskLevel`、`reasons`、六项 `signals`、`requiresPlan`、`requiresApproval` 和 `error: null`。`requiresPlan` 仅在 STANDARD 时为 true；`requiresApproval` 在 STANDARD，以及 DIRECT 的非 low 风险或任一风险信号成立时为 true。这些只是分类结果，不执行计划或审批流程；false 不代表目标、范围或执行前检查已齐全。新增枚举及审批语义变化使协议升级到 2.0，外部调用方应按新版本处理；旧会话结果仍可展示。

模型提交的 JSON 经过完整字段/类型/范围校验；开发任务仅在任一风险信号、非 low 风险等级、重要设计决策或依赖性分阶段实施触发时使用 STANDARD，其风险等级至少为 medium；无触发项时使用 FAST，不依赖模型的 route 偏好。开发任务提交 NONE／DIRECT 是协议错误，不以格式矛盾为由启动复杂工作流。操作任务必须使用 DIRECT，内部 assessment 全为 false；不应用开发复杂度判断，保留实际风险等级和风险信号。操作任务提交其他路由、assessment 含 true，或纯咨询提交 DIRECT 时视为协议错误，不自动放行为操作任务。无法解析或校验、启动时模型不可用或任务超限时输出 `status: "error"`、`intent: "unknown"`、`route: "NONE"` 及错误码，**不能把这种 NONE 当作非开发任务的成功分类**。不会从 Markdown 围栏或说明文字中猜测 JSON，也不额外请求模型修复；提供商请求失败与重试使用 Pi 原生处理。

只读调查仅在可信项目中启用，由主 Agent 按任务选择证据，不再预先截取前 250 个路径或文件开头 4 KiB：

| `gkd_route_evidence.action` | 能力 |
| --- | --- |
| `find` | 在 `path` 指定的文件或目录内查找；可用项目根相对 glob `pattern`（如 `**/*.md`）筛选 |
| `search` | 在指定范围内进行区分大小写的字面关键词搜索，返回 `路径:行号:内容`，不执行正则或 shell |
| `read` | 按行读取源码、测试、需求／架构文档及配置；分页和截断复用 Pi 原生读取实现 |
| `log` | 查看项目范围或指定文件的提交哈希、日期和标题 |
| `show` | 读取指定提交中的单个历史文件 |
| `diff` | 读取单文件差异：`revision`（默认 HEAD）与 `to`（默认工作区）；不包含未跟踪的新文件 |
| `blame` | 查看单个已提交文件的行归属，不代表当前未提交内容 |

`path` 默认为项目根（`read/show/diff/blame` 必填）；`revision/to` 仅接受提交哈希或 HEAD 及其祖先表达式（如 `HEAD~1`）；`revision` 默认 HEAD，`to` 省略时与工作区比较。`offset` 从 1 开始，`limit` 默认 100、最多 2000；查找／搜索／日志分别按结果或提交分页，其余按输出文本行分页。按返回提示继续读取，或缩小范围。搜索行和提交标题最多显示 2000 字符，完整源码请用 `read/show`。例如主 Agent 可先查找 `{"action":"find","pattern":"**/*.md"}`，再读取 `{"action":"read","path":"docs/requirements.md","offset":100,"limit":80}`。

调查先定位相关实现、调用方、测试和需求文档；当前代码无法解释约束或设计原因时，再按需查询历史。历史不是当前事实，文档与代码矛盾必须记录；调查到足以支持分流就停止，不要求执行所有查询，不穷尽仓库。非 Git 项目也能查找、搜索和读取，历史查询失败则明确留下证据缺口。纯解释无需调查；操作分类无需调查开发复杂度，也不执行用户要求的操作。

安全与资源边界：

- 只访问项目根目录内的普通文本文件；读取时校验真实路径、拒绝符号链接，并使用只读／不跟随末级链接的文件句柄。允许常见源码、Markdown／MDX／RST／TXT、JSON／YAML／TOML、`go.mod` 和 `Makefile`。
- 排除 `.git`、`.pi`、`.agents`、`.ssh`、`.aws`、`.gnupg`、依赖及常见生成目录，以及 `.env*`、`.npmrc`、`.netrc`、secret／credential 命名的文件或目录。拒绝越界、二进制及非普通文件；历史读取也校验文件类型和大小。
- 包含未跟踪文件，也不以 `.gitignore` 作为隐私边界；被忽略但未命中上述排除规则的文档／源码可能被搜索或读取。
- 每次返回约 50 KiB 以内；单文件及单条 Git 查询输出上限 8 MiB，超过时报告不可用。单次调查工具调用最多 10 秒，每条 Git 命令最多 5 秒；较大仓库应按目录／关键词缩小搜索。搜索明确报告已跳过的不可读、二进制或超大文件，未展示的内容不能当作已调查。
- Git 使用固定子命令和结构化参数，不经 shell；禁用分页器、外部 diff、textconv、fsmonitor 和缺失对象的自动网络拉取。不运行测试、项目脚本、提交或其他写操作。这是受控只读入口，不是操作系统沙箱。

文件、文档和历史都不能证明测试已运行；证据缺失本身不升级，有具体 STANDARD 触发项才升级，否则仍默认 FAST。未知如实说明，已发现的重要风险不得忽略。分流协议、开发默认策略和 `/gkd` 占位状态均未改变。

**提示词、路径及查到的源码／配置／需求文档／Git 历史会发送给当前模型的提供商**，并保留在当前会话。文件名排除规则不是秘密扫描器，允许文件中硬编码的敏感值仍可能发送；请仅在允许向该提供商发送这些项目内容时使用。

任务长度上限为 16,000 字符；忙碌时拒绝启动，不把调试任务插入正在执行的开发回合。不再设置独立的两次请求／60 秒超时；主 Agent 可以进行多个原生工具回合，消耗包含当前会话上下文，可使用 Pi 原生取消。`confidence` 是模型自评，非校准概率；上表示例仅用于说明，不写入分类指令。单元测试检查提示词协议并模拟主 Agent 的工具提交，验证结构与安全收敛，不代表真实模型准确率。

参考包 `extensions/gkd-workflow/pi-dev-workflow/` 未接入运行；因其与当前宿主类型存在兼容错误，主包类型检查排除该目录，未修改参考源码。

```bash
# 加载整个包，或只加载 gkd-workflow
pi -e .
pi -e ./extensions/gkd-workflow/index.ts
```

## GKD PR / MR Skill

`skills/gkd-pr/SKILL.md` 随 Pi Package 自动发现，亦可通过 `/skill:gkd-pr` 单独调用。它提供 FAST、STANDARD 两套 PR / MR 正文模板：

- `skills/gkd-pr/references/FAST.md`：变更摘要、实际验证和已知风险。
- `skills/gkd-pr/references/STANDARD.md`：额外记录背景、STANDARD 升级依据、重要设计权衡、分阶段实施及回滚方案。

默认流程：

1. 输入 `/gkd <任务>`，通过 `judge-route` 只读工具获得有效的 FAST / STANDARD / DIRECT / NONE 分类。
2. 分类成功后恢复正常工具，主 Agent 执行任务；STANDARD 根据实际风险先完成必要计划与审批。
3. 开发与验证后，若有任务相关提交、未被用户禁止发布，且存在可写且已认证的 GitHub 或 GitLab 远程仓库，按路由加载对应模板并尝试创建／更新 PR 或 MR。远程仓库不明确、凭据/工具不可用、提交或验证状态有问题时，保留本地改动并报告阻碍，绝不假报发布成功。
4. DIRECT 仅在用户明确要求创建 PR/MR 时发布；NONE 不发布。并不自动合并 PR/MR。

优先使用可用的仓库集成，也可使用已安装并认证的 `gh` 或 `glab` CLI。不会自动安装 CLI、获取凭据、强制推送或提交无关文件。模板中的测试勾选项仅标记实际通过的验证。Skill 和执行提示均为 Agent 指令，**不是一个独立的确定性发布服务**：最终创建取决于模型执行、仓库状态、可用工具和远程权限。

## 竖线光标

`extensions/bar-cursor.ts` 仅将终端原生光标设为闪烁的竖线，不再开启、覆盖或恢复 Hardware cursor 设置；不替换编辑器、不挂载 widget，也不修改 Pi 的 `settings.json`。

首次在 TUI 中加载时，扩展提示在 `/settings` 中将 **Show hardware cursor** 设为 `true`（已开启则无需操作）。提示后创建独立标记 `~/.pi/agent/bar-cursor-notice-shown`，后续重启、切换会话及 `/reload` 不再重复提示；设置了 `PI_CODING_AGENT_DIR` 时标记存放在该目录。无法保存标记时会警告，下次启动可能再次提示；删除标记可重新显示提示，卸载重装不会自动清除标记。print/JSON/RPC 或非 TTY 模式不提示，也不创建标记。

Hardware cursor 关闭时仍显示 Pi 的块状假光标，插件不会强制重新开启。开启后的假光标移除、字符宽度和输入法定位由 Pi 原生 TUI 处理；自定义编辑器也需使用 Pi 的原生光标标记。启动时竖线形状仍在 `session_start` 应用，若终端默认光标是块状，首帧仍可能短暂显示块状硬件光标；可将终端默认光标也设为竖线。

```bash
# 加载整个包，或只加载光标扩展
pi -e .
pi -e ./extensions/bar-cursor.ts
```

若已安装 `@joyanhui/pi-ext-bar-cursor`，请先在 `pi config` 中禁用旧扩展，避免它继续接管编辑器。

扩展仅在 TUI 模式且标准输出是 TTY 时写入 DECSCUSR 控制序列，不影响 print/JSON/RPC 输出。会话退出、切换及重载时恢复终端默认光标形状，而非精确还原此前形状；强制终止进程无法保证清理。终端需支持 DECSCUSR，实际形状与闪烁行为取决于终端实现。外部程序若修改光标形状，本扩展不会持续覆盖，下一次会话启动时重新应用。

## 目录约定

```text
extensions/
  bar-cursor.ts        # 首次开启提示、光标形状与退出清理
  codex-setting/
    index.ts           # /codex-setting 命令、会话状态与请求钩子
    menu.ts            # 原生设置列表与 Fast 行内切换
    settings.ts        # 全局默认值读写
  gkd-workflow/
    index.ts           # /gkd、/gkd-settings 与分流注册
    execute.md         # 分类成功后的执行与 PR/MR 发布阶段
    judge-route/
      index.ts         # 指令加载、调试命令、只读工具、安全校验与生命周期
      policy.md        # 分流原则、证据纪律与输出协议
      workflow.md      # 主 Agent 调查与结果提交步骤
skills/
  gkd-pr/
    SKILL.md           # PR/MR 发布 Skill
    references/
      FAST.md          # FAST 变更正文
      STANDARD.md      # STANDARD 设计、风险与验证正文
tests/
  bar-cursor.test.mjs
  codex-setting.test.mjs
  gkd-workflow.test.mjs
package.json           # 包信息与 pi 资源清单
pnpm-lock.yaml         # 固定开发依赖
pnpm-workspace.yaml    # pnpm 安全策略配置，非多包工作区
tsconfig.json          # 只做类型检查，不输出产物
```

简单扩展也可以直接放在 `extensions/<name>.ts`。辅助代码留在所属扩展目录内，不提前抽取共享层。

新增扩展时，在 `package.json` 的 `pi.extensions` 中显式列出入口，避免将辅助模块当作扩展加载。

当前 `skills/gkd-pr/` 已加入 `package.json` 的 `pi.skills` 与 `files` 发布清单。其他资源目录在需要时创建，并同步更新清单：
- `prompts/<name>.md`：可复用提示词。
- `themes/<name>.json`：主题。

## 依赖与分发

统一使用 pnpm 管理依赖，仅保留 `pnpm-lock.yaml`，不混用 npm/yarn 锁文件。pnpm 安装时为已有的 `@earendil-works/pi-tui@1.3.0` 自动生成了精确版本的 `minimumReleaseAgeExclude`，保存在 `pnpm-workspace.yaml`；其他依赖仍遵循默认发布时间检查。

Pi 宿主提供的库放在 `peerDependencies`，不要放进 `dependencies` 或打包进产物。本地类型检查需要的宿主库同时放进 `devDependencies`；其他运行时依赖才放在 `dependencies`。

当前设置 `private: true`，防止误发布 npm。使用本地路径或 Git 分发不受影响；如需发布 npm，先选择可用包名并移除 `private`，使用 `pnpm pack --out /tmp/pi-packages.tgz` 后通过 `tar -tzf /tmp/pi-packages.tgz` 检查发布内容。

只有需要独立安装、版本和发布时，才将扩展拆成 `packages/<name>/` 多包结构。

扩展与 Pi 进程拥有相同系统权限，请仅加载可信代码。

## 文档

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)

## Pull Request 模板

仓库提供两套 PR 正文模板，按 GKD 开发分流选择：

- **[FAST](https://github.com/linct96/pi-packages/compare/main...main?expand=1&template=FAST.md)**：默认开发流程，记录变更摘要、影响范围、已完成的验证及已知风险。无需为了填写模板而引入正式设计/审批流程。
- **[STANDARD](https://github.com/linct96/pi-packages/compare/main...main?expand=1&template=STANDARD.md)**：有明确复杂度/风险触发项的开发任务，补充背景、方案权衡、设计决策、分阶段计划、兼容性/安全/迁移、验证与回滚。可先建 Draft PR。

模板源码位于 `.github/PULL_REQUEST_TEMPLATE/`。创建 PR 时可在比较页 URL 加 `?template=FAST.md` 或 `?template=STANDARD.md`（已有查询参数则使用 `&template=...`）。上方链接打开模板入口，实际创建时仍需选择包含代码修改的 head 分支。路由判断以 `extensions/gkd-workflow/judge-route/policy.md` 为准；DIRECT / NONE 不属于开发 PR 模式。
