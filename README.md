# pi-packages

个人 Pi 扩展集合。当前使用单个 Pi Package，按功能组织扩展，无需构建或打包。

## 环境与开发

- Node.js >= 22.19.0
- pnpm 11.8.0（版本由 `package.json` 的 `packageManager` 固定）
- Pi；当前开发类型基于 `@earendil-works/pi-coding-agent@1.2.0`

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm format
pnpm lint
pnpm check
pnpm test

# 从仓库根目录临时加载整个包，不修改 Pi 配置
pi -e .
```

启动后输入 `/codex-settings` 打开 Codex 设置。修改扩展后执行 `/reload`。

只调试一个扩展时：

```bash
pi -e ./extensions/codex-settings/index.ts
```

`pnpm format` 使用 Oxfmt 格式化代码与文档，`pnpm lint` 使用 Oxlint 检查代码，警告也视为失败。两者均排除未接入运行的 `extensions/gkd-workflow/pi-dev-workflow/` 参考源码；格式化另外跳过由 pnpm 管理的锁文件。

`pnpm test` 使用 Node.js 内置测试运行器与 TypeScript 类型擦除，不依赖额外测试框架；部分 Node.js 版本会显示实验性类型擦除提示。

## Footer Status

`extensions/footer-status/index.ts` 在 TUI 启动／重载时替换原生底栏，使用当前主题的 `dim` 色，不修改 Pi 本体或用户配置。布局如下（模型信息动态读取，不写死示例名称）：

```text
~/project (main)               $0.123 | 8.0%/200k | gpt-6.1-sol (sub) • high
| Codex Fast | | Model Probe | GKD Auto · on
```

第一行左侧只展示目录和 Git 分支，不展示会话名称；右侧按「计费信息 | 上下文信息 | 模型 (提供商) • 思考程度」（`|` 和 `•` 两侧均各留一个普通空格）展示。提供商 `openai-codex` 简写为 `sub`，`openai` 简写为 `api`，其他提供商保留原名；不再单独显示费用订阅或 `(auto)` 标记；底栏不再展示 TPS／TTFT 和 Token 统计；扩展状态按键名排序，共用第二行，没有状态时不占行。窄窗口仍优先保留左侧路径和 Git 分支；右侧按「模型 → 思考程度 → 上下文 → 计费 → 模型提供商」的优先级保留完整字段。宽度足够时保留完整目录（用户主目录仍显示为 `~`）；空间不足时才参考 Cota 缩写中间目录：普通目录取首个 Unicode 字符，隐藏目录保留 `.` 和后一个字符，保留根路径、`~` 和最后一级目录全名，例如 `~/Developer/github/pi-packages` → `~/D/g/pi-packages`。缩写后仍放不下，再依次隐藏提供商、计费、上下文、思考程度、模型，最后隐藏 Git 分支；仅缩写路径本身仍放不下时才截断，不换行。窗口变宽会恢复完整路径。保留的模型信息仍在右侧。

一次完整对话任务成功结束后，仅在最终回答后以 `dim` 色追加一行统计；中间的模型回复、工具调用、重试和自动续跑均不单独展示。窄窗口截断而不换行：

```text
TPS 42.3, TTFT 0.85s, in 12k, out 800, cr 9.0k, total 22k, CH 75.0%, time 120.2s
```

指标字段统一使用「名称简写 + 空格 + 数值」，以 `, ` 分隔；末尾的 `time` 为一位小数的整轮耗时，单位秒。`in`／`out` 为本轮累计输入／输出 Token，`cr`／`cw` 为本轮累计缓存读取／写入 Token，`total` 为本轮提供商报告的 `usage.totalTokens` 合计，位于 `CH` 左侧；Token 用量为零时隐藏，`CH` 按本轮缓存读取量占输入与缓存 Token 总和的比例计算。底栏费用仍为整个会话累计；已保存的历史统计文本保持原样。

末尾的 `time 120.2s` 从首次 `before_agent_start` 累计至 `agent_settled`，包含首字等待、模型生成、工具执行、重试等待和同一任务内的多次请求；不是单次模型耗时。`agent_end` 可能仍有重试或续跑，因此不提前展示或清零；`agent_settled` 后清零，不计任务间的空闲时间。会话切换、分支导航或重载也会清零。使用本地单调时钟，不依赖第三方 Elapsed 扩展、后台计时器或其暂停控制。

`TPS` 汇总本轮具有有效计时的成功模型请求，使用这些请求的 `usage.output` 合计除以请求完整耗时之和；每次请求从 `before_provider_request` 计至模型回复结束，包含首字等待／预填充和隐藏思考，不扣 TTFT、不含工具执行或请求间等待，不按字符估算，也不额外叠加推理 Token。`TTFT` 取本轮首次有效请求从发送钩子到首个非空文本／思考／工具参数 delta 的时间，单位秒；连接成功、空片段和 start 事件不算首字。这是客户端观察到的整轮模型请求吞吐，受网络和提供商 Token 口径影响，不等同于服务端纯解码速度。

整轮计时和统计文本在 `agent_settled` 按最终回答的原生 entry ID 写入一条非 LLM 的 `footer-status:timing` 会话条目，通过 entry renderer 展示，不使用通知；不会修改原生消息／usage／duration 或发给模型。Token 仅汇总本轮开始后新增的用量，包含本轮模型、工具、缓存预热和摘要，不带入以往对话或其他历史分支。统计写入后不随后续回复变化，恢复会话／分支导航／重载时保持原快照；旧计时条目没有统计快照时不补写、不占行。最终回复缺少有效计时、最终错误、取消或仅停在工具调用时不追加统计；中途错误后重试成功仍只展示一次。空输出不显示 TPS／TTFT，请求总耗时为零时不显示 TPS。不增加后台计时器或模型请求。

若同时安装 `@router-for-me/pi-cliproxyapi-provider`，可通过 `pi config` 单独禁用其 `extensions/tps.ts`，避免它继续输出独立的 TPS 通知；本扩展不拦截其他扩展的通知。

仅 TUI 生效，RPC／print／JSON 不受影响。包加载后执行 `/reload` 即可生效；禁用此扩展并重载可恢复原生底栏。不能与另一个 `setFooter()` 扩展叠加，最后设置者生效。

## Codex 设置

运行 `pi -e .` 后输入 `/codex-settings`，直接在 **Fast** 设置行切换，无需进入子菜单。

```text
Codex Settings

❯ Fast           off
  Model Probe    off
```

Fast 沿用 Pi 原生设置列表的行内切换：

- `Space` / `Enter` 在 `off` 和 `on` 之间切换，立即应用到当前会话，不修改全局默认值。
- Fast 行显示当前会话值；下方 `Default: off/on` 显示已保存的全局默认值。
- `Ctrl+S` 将当前会话值保存为全局默认值，菜单保持打开。
- `Esc` 关闭菜单，不撤销已应用的切换。
- 保存期间切换及重复保存会被忽略；`Esc` 请求取消保存，结束后保留菜单与当前会话值。

菜单内快捷键沿用 Pi 的 `tui.select.*` 和 `app.models.save` 配置；如果你重绑了模型选择器的保存键，这里也会随之变化。

在主输入框按 `Cmd+Shift+F`（Pi 键名 `super+shift+f`）可直接切换当前会话的 Fast 开关，无需打开菜单；会显示 `Codex Fast: on/off` 提示，并同步底栏状态，不修改全局默认值，从后续请求起生效。该快捷键不通过原生 `keybindings.json` 配置。终端需支持上报 `super` 修饰键（通常通过 Kitty 键盘协议），且不能被终端自身的搜索等快捷键拦截；不支持时仍可使用 `/codex-settings`。

Fast 默认为 `off`。`on` 为当前选中的 `openai-codex` / `openai-codex-responses` 模型请求设置 `service_tier: "priority"`，不改变模型、推理强度或其他请求字段；`off` 不改写请求，不会清理其他配置或插件自行设置的 tier。不会改写其他 provider、不同模型或虚拟模型路由后的请求。

仅在 Fast 已启用且当前模型的 provider 为 `openai-codex`、API 为 `openai-codex-responses` 时，Pi 底部状态栏显示 `Codex Fast`；关闭或切换到其他模型时移除。切换模型、恢复会话和分支导航时同步显示状态；隐藏标记不会关闭 Fast，切回支持的 Codex 模型后自动恢复显示。该标记表示开关已开启，不表示服务端已确认 Priority；非 Codex 请求仍不受影响。使用原生扩展状态接口，不替换现有底栏；自定义底栏需支持显示扩展状态。

标记使用当前主题的 `dim` 色，与原生底栏一致，不写死 RGB，也不额外加粗或放大。字号和字体继承终端配置，Pi 插件不能单独设置。状态接口缓存已着色文字，切换 Pi 主题后执行 `/reload` 刷新标记颜色。

全局默认值独立保存在 `~/.pi/agent/codex-settings.json`（设置了 `PI_CODING_AGENT_DIR` 时使用该目录），不修改 Pi 的原生 `settings.json`。配置文件名、会话存储键和状态栏键统一使用 `codex-settings`，不读取旧名称或迁移旧会话状态；切换到新版后请新建会话。

保存保留临时文件加原子替换，并增加轻量冲突检测：

- 每次打开菜单读取磁盘默认值；菜单保存同时保存 Fast 与 Model Probe 开关，若整个配置与打开时不同，提示重新打开菜单，不覆盖。
- 使用同目录 `codex-settings.json.lock` 排斥同时保存；遇到锁立即提示稍后重试，不阻塞菜单。正常结束、失败及取消均清理自己的锁和临时文件。
- 保存时保留其他配置字段，替换前再次检查文件内容，发现保存期间的外部修改则拒绝覆盖。配置损坏同样提示错误，不会静默覆盖。
- 锁约束使用本插件的写入进程，不能完全消除不遵守锁协议的外部编辑器在最后检查与替换之间的竞争。进程被强制结束可能残留锁；只有确认没有其他进程正在保存时，才能手动移除错误提示中的锁文件。

切换应用失败时显示 `Application failed`，设置行恢复原值，可再次按 `Space` / `Enter` 重试。保存失败时显示 `Save failed`，默认值标记不变，不撤销此前已应用的会话值；可再次保存重试。

菜单销毁、切换模型、会话退出/重载或分支导航会使旧菜单失效并取消未完成的保存；切换应用前还会复核会话和模型身份，过期结果不会修改新会话或刷新旧界面。取消会在文件操作和替换前检查，但无法撤销已经完成的原子替换；因此临界时刻取消可能已保存默认值。

当前会话的确认值记录在会话自定义条目中，重载/恢复会话和分支导航时恢复；没有该条目的新会话使用全局默认值。全局默认值同样适用于 print/RPC 等模式，但菜单仅在 TUI 模式可用。

Priority 的可用性、速度与实际计费由账号及服务端决定；不保证加速，Pi 展示的费用估算不能代替账单。

### Model Probe

在同一菜单切换 **Model Probe**，`Ctrl+S` 保存为新会话的默认值，`Esc` 关闭。默认关闭，与 Fast 独立。**新会话收到第一条普通用户消息时才启动检测**，仅打开会话或执行 `/new` 不调用模型；首条消息（含附图）先暂存，通过后再自动执行；失败时也可明确选择在当前会话继续。尚未对话的新会话中开启开关后直接发送 `hi` 即可触发，不必先保存全局默认值。切换不会追溯检测已有对话，也不会取消正在进行的检测或绕过失败门禁。空输入、扩展注入、斜杠命令和流式追加不作为首次检测触发点；普通 TUI/RPC 输入及纯图片输入均支持。

在主输入框按 `Cmd+Shift+P`（Pi 键名 `super+shift+p`）可直接切换当前会话的 Model Probe 开关，同步菜单和状态栏并提示 `Model Probe: on/off`，不修改全局默认值，也不立即发起检测。与 `Cmd+Shift+F` 一样，需要终端支持上报 Super 修饰键且不被终端自身快捷键拦截；不支持时仍可使用 `/codex-settings`。

开启时，TUI 底部状态栏显示 `Model Probe`，样式与 `Codex Fast` 一致，可同时展示；关闭时移除。会话启动、重载／恢复及分支导航时同步开关状态，不限模型 provider。标记仅表示 Model Probe 已开启，不代表检测已经通过，也不会触发检测；RPC／print／JSON 不设置此状态栏标记。

Model Probe 与 Fast 共用 `~/.pi/agent/codex-settings.json`（尊重 `PI_CODING_AGENT_DIR`），支持仅包含 `{ "fast": false }` 的最小配置。可直接编辑问题与答案，然后新建会话并发送首条消息：

```json
{
  "fast": false,
  "modelProbe": {
    "enabled": true,
    "questions": [
      {
        "id": "japan-pm",
        "question": "不要联网直接回复我现在的日本首相是谁？直接回答名字！",
        "answer": "高市早苗"
      }
    ],
    "validation": { "mode": "contains", "requireAll": true },
    "isolation": { "disableTools": true, "clearSystemPrompt": true },
    "onFailure": { "confirmRestart": true }
  }
}
```

只提供 `modelProbe.enabled` 时使用上面的默认问题和规则；显式配置的题目不能为空，ID 必须唯一，每题必须有非空问题和答案。目前只支持 `contains`、全部通过和开启上述隔离／重试确认保护，不接受关闭保护或其他校验模式。未知字段保留；损坏或非法配置会报错并阻止任务，不使用半份配置。时效性问题的答案需要用户维护，上面的答案只是可修改的预设，不是身份认证依据。

- **当前模型原生回合**：不创建测试 Agent、不切换模型、不调用额外 LLM API。保留当前 provider、model、thinking、请求参数及 Fast/Priority。每题按顺序独立请求，本地做 NFKC／空白归一化和包含校验，任一错误、空回答、截断、请求异常或取消即失败。问题和真实回复保留在会话中；标准答案只在非 LLM 自定义状态和本地失败确认中使用，不发给模型。
- **仅检测请求隔离**：`before_agent_start` 清空强制系统提示词，`context_with_system` 只投影空 system 与当前问题，移除业务历史、AGENTS、Skills 和全部工具声明；`tool_call` 再阻断执行。额外清除 Codex 序列化器为空 system 填入的默认 `instructions`。不调用 `setActiveTools([])`，不改全局工具集；结束后正常回合沿用原环境。
- **TUI 检测面板**：复用第一条 `[codex-settings:model-probe]` 消息区域，在面板最下方显示「检测中...」「检测通过」「检测失败」等状态提示，每题按「问题：」「答案：」「回答：」顺序展示检测题目、预设标准答案和模型实际回复，并保留失败原因，不展示日志区域或逐题「判定」行；后续题目不再新开可见检测消息。明确跳过失败继续当前会话时显示「检测失败（已选择继续）」，不误报通过。过程日志仍保存在非 LLM 会话状态中，但不在面板展示，也不作为模型上下文。面板可用后不再重复弹出扩展通知；无面板、配置错误或持久化失败时仍保留显眼错误提示。只使用现有 Pi 发行版接口，不修改宿主，不隐藏或改写原生模型流式回复、思考及宿主错误；面板内的回答是检测完成后的汇总，原生输出仍可能单独出现。RPC／print／JSON 保持原有消息和通知路径。
- **成功**：持久化 `PASSED`，显示「回答正确」，进入 `READY`；若有真正未执行的暂存消息，先持久化 `DELIVERING`，再按原文和 Pi 原生附图自动续发。没有待处理消息时不发送业务任务。
- **失败**：持久化 `FAILED` 并阻止正常 Agent 输入／工具。TUI/RPC 交互区只显示一句话标题「模型检测未通过，请选择后续操作」和三个选项。TUI 借鉴 `@juicesharp/rpiv-ask-user-question` 的编号交互：`1`／`2`／`3` 直接选择，`↑`／`↓` 循环移动，确认键选择，取消键关闭；遵循 Pi 的按键配置，窄终端自动换行。只保留本流程需要的固定三选项，不增加问卷标签页、自定义文本或预览，不依赖该插件；RPC 继续使用原生选择框：
  1. **重新创建会话并发送消息**：携带原首条消息及附图到新会话，重新检测，通过后才执行。继承启用状态，即使尚未保存全局默认值；再次失败仍显示这三个选项，不自动无限重试。内部重启命令带一次性确认标识，只在命令上下文调用 `newSession({ setup })`。
  2. **继续当前会话并发送消息**：明确跳过本次失败，解除当前会话门禁并发送原消息及附图一次。不把检测改判为通过：保留失败回答和结果，记录 `user_override`；重载／恢复后仍可继续，不重复检测或发送。
  3. **取消**：留在失败会话，保留原消息，不发送；`Esc` 关闭选择框同样处理。
     print/JSON 无交互时报告错误，不自动重建或跳过检测。
- **暂存和交接**：同时只保留一条文本／图片任务，额外输入明确拒绝，不覆盖。确认重建时用 `codex-settings:model-probe-handoff` 自定义条目交接，不进入模型上下文。来源会话先标记已转交，避免恢复旧会话再交付一次；普通 `/new` 不会擅自携带其他历史任务。重建期间的新输入明确拒绝，请在新会话重发。
- **避免重复副作用优先**：交付尝试前就落盘；`/reload`、恢复或树回退发现已尝试交付／已转交（包括其他分支）时不自动重放。崩溃使交付结果不明确时保留失败状态和原文，请先检查真实执行结果，再决定是否手动重发。交接失败同样不自动重试任务；原消息仍保留在来源记录中。
- **生命周期**：尚未发送首条消息的干净会话 `/reload`／`/resume` 后仍等待首次输入，沿用会话开关，首次检测采用发送时所选模型／thinking。已通过会话 `/reload`／`/resume` 不重复检测；中断中的检测恢复为失败。旧版已有对话但无检测记录的会话不追溯检测。`/tree` 按当前分支重判，未验证节点不沿用其他分支的通过状态。包含检测记录的 `/fork` 不视为干净会话，要求 `/new`；旧版无检测记录的非空分叉按旧对话处理。改变模型／provider／thinking 使已记录结果失效，需要干净新会话重测。

实现和测试位于 `extensions/codex-settings/model-probe/` 与 `tests/model-probe.test.mjs`。测试覆盖真实 Pi SDK／Session runtime、离线 Faux 提供商，以及真实 Codex 序列化器配合模拟 HTTP/SSE：空提示词／工具、当前模型和推理强度、Priority、正常环境恢复、确认重建、附图交接、持久会话恢复及树／分叉门禁。

边界：这只是回答异常筛查，不能证明远端模型身份；远端隐藏提示词不可控。其他扩展更晚的 `context_with_system`／`before_provider_request` 仍可能改写最终请求，新增此类扩展需复验隔离。输入门禁不等于所有命令的沙箱：`/gkd` 发起的 Agent 输入会被阻止，但扩展命令本身仍可能修改自己的状态或执行宿主操作；Shell 和会话管理命令不由本插件全面接管。Pi 的发送 API 是 fire-and-forget，10 秒未观察到启动会报错并保持门禁；不会据此自动重发。检测会产生正常模型费用，问题、回答、配置快照和暂存任务按会话数据保护。

## gkd-workflow

- `/gkd <任务>`：启动 Extension 控制的 FAST / STANDARD 开发状态机，由当前主 Agent 完成规划、编码、测试与验收。
- `/gkd-settings`：全局个人设置菜单，切换“自动启用 GKD”；Space / Enter 行内切换并立即保存，Esc 关闭。
- `Cmd+Shift+G`（`super+shift+g`）：在主输入区直接切换自动启用并全局保存，不打开菜单。终端需支持 Super 修饰键（通常需要 Kitty 键盘协议）。
- `/gkd-judge-route <任务提示词>`：分流调试快捷入口，由当前主 Agent 只读调查并识别任务，不执行操作或开发、不创建计划或请求审批。

“自动启用 GKD”默认关闭，保存在 `~/.pi/agent/gkd-workflow.json` 的 `autoEnabled`（尊重 `PI_CODING_AGENT_DIR`），跨项目、跨会话共用，无项目级或会话级覆盖。菜单采用与 Codex Fast 相同的原生设置列表，但每次切换直接保存全局值，不另设“保存为默认”。保存成功才生效，原子替换并保留其他配置字段；设置损坏或写入失败会报错，不覆盖原文件。开启时状态栏显示 `GKD Auto · on`。设置菜单和快捷键仅 TUI 可用，不调用模型。

开启后，没有未结束 GKD 任务时，普通用户输入（含 RPC）自动进入同一个分流／开发流程，复用当前原生输入并保留附图，不额外发送启动消息。每次可自动触发的新输入重新读取全局值，因此其他已打开会话也会在下一次输入时应用最新设置。NONE / DIRECT 直接回到普通对话／操作授权，不重复分流。关闭后仍可手动 `/gkd <任务>`。

自动入口不接管扩展注入消息、斜杠命令／技能／模板、Shell 快捷输入、空文本或执行中的追加输入。纯图片无文字输入仍按原生方式处理。已有任务时沿用原有审批、暂停、恢复、取消规则：切换开关不终止、批准或自动恢复当前任务，暂停／阻塞的任务不会被新输入替换。自动启动遇到设置损坏、无模型、不可信项目或任务超长时，提示并停止本次输入，不静默绕过流程；修复后重发，或显式使用 `/gkd`。

### 开发状态机

```text
FAST:     ROUTING → IMPLEMENTING → VERIFYING → COMPLETED
STANDARD: ROUTING → PLANNING → AWAITING_APPROVAL → IMPLEMENTING → VERIFYING → COMPLETED
```

采用类似 BMAD 的轻量分工：Extension 只强制主流程和核心门禁，主 Agent 负责理解需求、检查实际差异、执行测试和逐项验收。`state.ts` 校验基本状态与合法转换、原子保存 JSON；`workflow.ts` 处理阶段、权限、用户审批和会话生命周期；`workflow.md` 描述主 Agent 的执行与验收纪律。分类继续复用 `judge-route`，不启动嵌套模型、不加载旧版 `pi-dev-workflow`。NONE / DIRECT 成功后离开开发状态机，按普通对话／操作授权处理，分类本身不是执行授权。

- **核心门禁**：只允许一个当前任务；Agent 通过 `gkd_report` 申请阶段变化，不能指定 phase 或自行批准、恢复、取消任务。每次报告携带当前 `taskId` 与 `planVersion`。状态栏显示如 `GKD · STANDARD · VERIFYING`。
- **STANDARD 审批**：`plan` 是 Markdown 文本，主 Agent 写清目标、范围、风险、带路径的实施步骤、可观察验收标准及自动／人工验证方式。提交计划递增版本，通过 Pi 原生确认或用户明确输入“批准当前计划”批准该任务／该版本。修改计划作废旧审批；关闭确认框只是等待。审批前仅开放受控只读调查与报告工具，Shell、写入、包装及未知工具仍在 `tool_call` 被拒绝。
- **实现与验证**：`implemented` 提交实际修改摘要 `summary`，进入 VERIFYING；实现和验证阶段使用原工具集，不要求命令与计划逐字匹配。主 Agent 查看真实差异、执行适合项目的检查、读取实际结果，并逐项核对验收行为。代码改变后应重跑相关检查；跳过、未执行或无关断言不能当作通过。没有自动化方式时记录具体人工观察，需要用户检查则阻塞等待，不编造确认。
- **完成与修复**：`verified` 提交 `passed` 和验证／验收摘要 `summary`。Controller 按当前阶段和报告推进，不抓取或认证测试工具输出、不计算代码指纹、不自动证明验收充分。报告失败最多自动回到实现阶段修复两次，之后 BLOCKED；恢复不重置次数。**COMPLETED 表示主 Agent 已报告完成，不是独立质量认证。**
- **重大变化**：主 Agent 发现新风险、原计划失效或范围扩大时报告 `reevaluate`，直接进入 STANDARD 的 PLANNING，重新提交计划和审批。无法继续时报告 `blocked`，保存原因并等待用户。
- **中断／恢复／取消**：原生中断、关闭／重载、分叉／切换会话分支或其他对话会暂停。说“继续上次任务”恢复，也可用“继续上次任务：<补充需求>”补充意图；说“取消当前任务”才永久取消，不撤销代码。恢复只校验会话和项目路径，实际工作区、中断操作及阻塞条件交由主 Agent 重新检查；丢弃旧验证报告，STANDARD 重新规划审批。普通闲置等待审批不自动暂停。
- **持久化**：状态保存在 `~/.pi/agent/gkd-workflow/<sessionId 的 SHA-256>/<taskId>.json`（尊重 `PI_CODING_AGENT_DIR`），记录任务、原工具集、计划／审批、实施摘要、Agent 验证报告和恢复信息。临时文件独占创建、文件 fsync 后原子 rename，权限 0600；保存失败仍阻止继续执行。状态格式为 v2，旧试验版 v1 不迁移，恢复失败时可用 `/gkd <任务>` 启动新任务，旧文件不覆盖。

不增加工作区扫描、子模块指纹、测试结果解析、跨进程锁或其他边界编排。原子写入只防半份 JSON；不要用多个 Pi 进程同时恢复同一任务，也不把工具门禁当 OS 沙箱。计划、摘要和会话含项目内容，请按会话数据保护。

不调度 Coding / Review Subagent，不编排多任务；完成后不自动 Commit、Push、发布 PR/MR 或调用 `gkd-pr`。测试聚焦主流程和核心门禁，并以真实 Pi SDK／资源加载器、离线 Faux 模型及真实工具贯通 FAST、STANDARD 和恢复流程；不以测试声称真实模型能充分验收需求。

### 任务路由识别

分流是 **GKD 主 Agent 工作流中的一个阶段**，不是扩展内部的独立模型请求。分流模块位于 `extensions/gkd-workflow/judge-route/`：`policy.md` 描述分流原则、证据纪律和输出协议，`workflow.md` 描述主 Agent 的调查与提交步骤；`index.ts` 加载这两份指令，负责命令／工具注册、只读权限、结果校验及取消恢复。Markdown 按模块路径加载，不依赖待调查项目的工作目录；修改后执行 `/reload` 生效。独立调试入口保持只读、只分类；`/gkd` 与自动入口复用同一分类结果推进上述状态机；仅开启自动启用时接管符合条件的普通输入。

使用 `/gkd-judge-route`，例如：

```text
/gkd-judge-route 提交 A 项目当前修改
/gkd-judge-route 修复按钮颜色错误
/gkd-judge-route 修改身份认证逻辑
/gkd-judge-route 解释 React useEffect
```

| 任务示例                                     | 预期路由                                 |
| -------------------------------------------- | ---------------------------------------- |
| 提交 A 项目已有修改                          | DIRECT（执行前仍需核对项目、分支和差异） |
| 运行 A 项目现有测试并报告结果                | DIRECT                                   |
| 强制推送或发布生产环境                       | DIRECT（需要风险确认，不自动执行）       |
| 修复按钮颜色错误并提交                       | FAST（开发任务，提交只是收尾）           |
| 解释如何提交代码                             | NONE                                     |
| 修复按钮颜色错误                             | FAST                                     |
| 修改单个组件的文案                           | FAST                                     |
| 重构规则集的数据模型                         | STANDARD                                 |
| 增加数据库迁移                               | STANDARD                                 |
| 修改身份认证逻辑                             | STANDARD                                 |
| 解释 React useEffect                         | NONE                                     |
| 按现有格式统一三个页面的按钮文案，并逐页检查 | FAST（影响已确认、无行为协调）           |
| 在两种状态管理方案中权衡后实施               | STANDARD                                 |
| 在数据库、服务端和客户端分阶段切换协议       | STANDARD                                 |
| 解释认证流程，不修改代码                     | NONE                                     |

判断遵循 **Task Route Policy v2.1**（JSON 结构仍为 2.0）。先判断任务性质：纯解释、咨询、讨论为 `non_development → NONE`；仅执行现成操作、不涉及实现变更为 `operation → DIRECT`；需要新增、修改或修复实现（包括混合操作的请求）为 `development → FAST / STANDARD`。DIRECT 根据任务内容判断，不根据用户指令的语气判断。

DIRECT 表示无需开发流程，不是执行授权：执行前仍需核对目标、范围和状态；缺少项目、分支等参数时在理由中记录待澄清，不升级成 STANDARD，也不把参数澄清当作风险审批。破坏性、对外发布或其他高风险操作仍需确认；执行中发现需要实现变更应重新按开发任务分流，不自行扩大任务范围。独立调试入口只做分类，尚无专用操作执行器或操作澄清／确认交互；证据工具可按需读取单文件差异和相关历史，但不提供完整的分支、工作区状态或外部环境核对，不得把 DIRECT 当作执行前检查已通过。

开发任务**默认 FAST，只有明确命中 STANDARD 触发条件才升级**。提示词分为决策原则、证据纪律和输出协议三部分，不依赖具体任务示例枚举。STANDARD 承担举证责任，必须说明具体触发项及任务或项目依据；不是要求 FAST 先证明五项条件全部成立。原有目标、实现、影响、低风险、验证五项内部字段仅保留观察含义，未知填 false，任意或全部为 false 都不单独升级。源码、调用方或测试资料缺失、尚未确定验证命令、低置信度也不单独升级；模型无触发项却提交 STANDARD，程序会归一化为 FAST。未知仍在理由中说明，FAST 不代表已验证安全或可以跳过执行前检查。

对于开发任务，架构/职责/边界变化、跨模块行为或契约协调、关键技术权衡、兼容性破坏、安全边界、数据迁移、无法安全地一次完成和验证的分阶段实施，以及经必要调查确认存在、会实质改变预期行为、方案或影响范围的重要未决问题，都触发 STANDARD。一般资料不足不属于这种重要不确定性；开发风险等级不能仅因无法证明低风险而填为 medium/high。多个文件的机械修改不等于跨模块协调；修改类型、数据模型或兼容地添加可选字段也不单独构成硬触发，需看语义、契约和风险。普通的查看、修改、测试步骤不等于分阶段实施。不能用文件数、代码行数或臆测的风险独立升级。

纯解释/咨询返回 NONE，不因出现认证、迁移等词语就成为开发任务；执行现成操作的请求不能归为 NONE。用户指定的模式只是偏好，不能替代 STANDARD 触发证据，也不能绕过已知风险的强制升级规则。发现关键证据缺失时明确记录缺什么，不编造源码、调用方或测试证据。与 BMAD 一样由主 Agent 执行工作流指令，但这里使用默认 FAST／明确触发才 STANDARD 的策略，不采用 BMAD 本地版本默认的代码行数阈值。独立调试命令不实现开发期间的 Loop、完成判定或持续升级；这些约束由 `/gkd` 状态机负责。

命令通过 `pi.sendUserMessage()` 启动主 Agent 的原生回合，附加分流指令而不替换宿主原有系统提示词。任务、调查结果和分类都会进入当前会话上下文；这不是隔离的临时分类会话，已有对话也可能影响判断。模型请求、思考级别、取消、错误处理和用量记录均由 Pi 原生 Agent 循环负责，正常进入 Pi 会话 Token／费用统计，不重复上报 usage；费用仍取决于提供商报告和价格配置。

调试期间只开放两个确定性工具：`gkd_route_evidence` 按需查找路径、搜索内容、分段读取和查询 Git 历史，`gkd_judge_route` 接收主 Agent 给出的 JSON、校验后结束调试。主 Agent 自行调查，不调用嵌套模型，也不提供子 Agent 委派；其他工具（包括任意 shell、写入、测试和委派）仍被拦截。结束、取消或会话退出时恢复原工具集，退出会中止尚未完成的调查；未提交结果就停止时显示警告，不伪造分类。

分类 JSON 保存在原生工具结果中并在 TUI 展示。成功结构包含 `schemaVersion: "2.0"`、`status: "ok"`、`intent`、`route`、`confidence`、`riskLevel`、`reasons`、六项 `signals`、`requiresPlan`、`requiresApproval` 和 `error: null`。`requiresPlan` 仅在 STANDARD 时为 true；`requiresApproval` 在 STANDARD，以及 DIRECT 的非 low 风险或任一风险信号成立时为 true。独立调试时这些只是分类结果，不执行计划或审批流程；false 不代表目标、范围或执行前检查已齐全。新增枚举及审批语义变化使协议升级到 2.0，外部调用方应按新版本处理；旧会话结果仍可展示。

模型提交的 JSON 经过完整字段/类型/范围校验；开发任务仅在任一风险信号、非 low 风险等级、重要设计决策或依赖性分阶段实施触发时使用 STANDARD，其风险等级至少为 medium；无触发项时使用 FAST，不依赖模型的 route 偏好。开发任务提交 NONE／DIRECT 是协议错误，不以格式矛盾为由启动复杂工作流。操作任务必须使用 DIRECT，内部 assessment 全为 false；不应用开发复杂度判断，保留实际风险等级和风险信号。操作任务提交其他路由、assessment 含 true，或纯咨询提交 DIRECT 时视为协议错误，不自动放行为操作任务。无法解析或校验、启动时模型不可用或任务超限时输出 `status: "error"`、`intent: "unknown"`、`route: "NONE"` 及错误码，**不能把这种 NONE 当作非开发任务的成功分类**。不会从 Markdown 围栏或说明文字中猜测 JSON，也不额外请求模型修复；提供商请求失败与重试使用 Pi 原生处理。

只读调查仅在可信项目中启用，由主 Agent 按任务选择证据，不再预先截取前 250 个路径或文件开头 4 KiB：

| `gkd_route_evidence.action` | 能力                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `find`                      | 在 `path` 指定的文件或目录内查找；可用项目根相对 glob `pattern`（如 `**/*.md`）筛选   |
| `search`                    | 在指定范围内进行区分大小写的字面关键词搜索，返回 `路径:行号:内容`，不执行正则或 shell |
| `read`                      | 按行读取源码、测试、需求／架构文档及配置；分页和截断复用 Pi 原生读取实现              |
| `log`                       | 查看项目范围或指定文件的提交哈希、日期和标题                                          |
| `show`                      | 读取指定提交中的单个历史文件                                                          |
| `diff`                      | 读取单文件差异：`revision`（默认 HEAD）与 `to`（默认工作区）；不包含未跟踪的新文件    |
| `blame`                     | 查看单个已提交文件的行归属，不代表当前未提交内容                                      |

`path` 默认为项目根（`read/show/diff/blame` 必填）；`revision/to` 仅接受提交哈希或 HEAD 及其祖先表达式（如 `HEAD~1`）；`revision` 默认 HEAD，`to` 省略时与工作区比较。`offset` 从 1 开始，`limit` 默认 100、最多 2000；查找／搜索／日志分别按结果或提交分页，其余按输出文本行分页。按返回提示继续读取，或缩小范围。搜索行和提交标题最多显示 2000 字符，完整源码请用 `read/show`。例如主 Agent 可先查找 `{"action":"find","pattern":"**/*.md"}`，再读取 `{"action":"read","path":"docs/requirements.md","offset":100,"limit":80}`。

调查先定位相关实现、调用方、测试和需求文档；当前代码无法解释约束或设计原因时，再按需查询历史。历史不是当前事实，文档与代码矛盾必须记录；调查到足以支持分流就停止，不要求执行所有查询，不穷尽仓库。非 Git 项目也能查找、搜索和读取，历史查询失败则明确留下证据缺口。纯解释无需调查；操作分类无需调查开发复杂度，也不执行用户要求的操作。

安全与资源边界：

- 只访问项目根目录内的普通文本文件；读取时校验真实路径、拒绝符号链接，并使用只读／不跟随末级链接的文件句柄。允许常见源码、Markdown／MDX／RST／TXT、JSON／YAML／TOML、`go.mod` 和 `Makefile`。
- 排除 `.git`、`.pi`、`.agents`、`.ssh`、`.aws`、`.gnupg`、依赖及常见生成目录，以及 `.env*`、`.npmrc`、`.netrc`、secret／credential 命名的文件或目录。拒绝越界、二进制及非普通文件；历史读取也校验文件类型和大小。
- 包含未跟踪文件，也不以 `.gitignore` 作为隐私边界；被忽略但未命中上述排除规则的文档／源码可能被搜索或读取。
- 每次返回约 50 KiB 以内；单文件及单条 Git 查询输出上限 8 MiB，超过时报告不可用。单次调查工具调用最多 10 秒，每条 Git 命令最多 5 秒；较大仓库应按目录／关键词缩小搜索。搜索明确报告已跳过的不可读、二进制或超大文件，未展示的内容不能当作已调查。
- Git 使用固定子命令和结构化参数，不经 shell；禁用分页器、外部 diff、textconv、fsmonitor 和缺失对象的自动网络拉取。不运行测试、项目脚本、提交或其他写操作。这是受控只读入口，不是操作系统沙箱。

文件、文档和历史都不能证明测试已运行；证据缺失本身不升级，有具体 STANDARD 触发项才升级，否则仍默认 FAST。未知如实说明，已发现的重要风险不得忽略。分流协议和开发默认策略不变；路由调查不等于开发验证，后者由主 Agent 实际执行并报告。

**提示词、路径及查到的源码／配置／需求文档／Git 历史会发送给当前模型的提供商**，并保留在当前会话。文件名排除规则不是秘密扫描器，允许文件中硬编码的敏感值仍可能发送；请仅在允许向该提供商发送这些项目内容时使用。

任务长度上限为 16,000 字符；忙碌时拒绝启动，不把调试任务插入正在执行的开发回合。不再设置独立的两次请求／60 秒超时；主 Agent 可以进行多个原生工具回合，消耗包含当前会话上下文，可使用 Pi 原生取消。`confidence` 是模型自评，非校准概率；上表示例仅用于说明，不写入分类指令。单元测试检查提示词协议并模拟主 Agent 的工具提交，验证结构与安全收敛，不代表真实模型准确率。

参考包 `extensions/gkd-workflow/pi-dev-workflow/` 未接入运行；因其与当前宿主类型存在兼容错误，主包类型检查排除该目录，未修改参考源码。

```bash
# 加载整个包，或只加载 gkd-workflow
pi -e .
pi -e ./extensions/gkd-workflow/index.ts
```

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
  footer-status/
    index.ts           # 底栏注册、回复计时与生命周期
    footer.ts          # 底栏渲染、累计用量与布局
  codex-settings/
    index.ts           # /codex-settings 命令、会话状态与请求钩子
    menu.ts            # 原生设置列表与 Fast 行内切换
    settings.ts        # 全局默认值读写
  gkd-workflow/
    index.ts           # 工作流与全局设置注册
    settings.ts        # 自动启用菜单、快捷键与全局配置读写
    state.ts           # 基本状态校验、合法转换、JSON 持久化
    workflow.ts        # 主流程、审批、权限、Agent 报告与恢复
    workflow.md        # 主 Agent 的阶段操作说明
    judge-route/
      index.ts         # 指令加载、调试命令、只读工具、安全校验与生命周期
      policy.md        # 分流原则、证据纪律与输出协议
      workflow.md      # 主 Agent 调查与结果提交步骤
tests/
  bar-cursor.test.mjs
  footer-status.test.mjs
  codex-settings.test.mjs
  gkd-workflow.test.mjs
  gkd-fsm.test.mjs
  gkd-host.test.mjs
  gkd-settings.test.mjs
package.json           # 包信息与 pi 资源清单
pnpm-lock.yaml         # 固定开发依赖
pnpm-workspace.yaml    # pnpm 安全策略配置，非多包工作区
tsconfig.json          # 只做类型检查，不输出产物
```

简单扩展也可以直接放在 `extensions/<name>.ts`。辅助代码留在所属扩展目录内，不提前抽取共享层。

新增扩展时，在 `package.json` 的 `pi.extensions` 中显式列出入口，避免将辅助模块当作扩展加载。

以下目录仅在需要时创建，并同步加入 `package.json` 的 `pi` 资源清单及 `files` 发布清单：

- `skills/<name>/SKILL.md`：模型工作指引与配套资源。
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
