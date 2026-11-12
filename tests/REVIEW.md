# 测试精简审查清单

> 以下是前次测试精简的历史记录。后续 Skill 主体迁移的范围变更见文末，原状态机用例不再代表当前插件能力。

审查基线：`4b7e0a7`；9 个测试文件，5,879 行测试代码。以下决定在实施重构前记录。
目标是减少维护成本，不追求覆盖率；只修改测试、测试入口和本清单，不修改业务逻辑。
用例名称按原文件顺序列出，较长名称保留可检索的前缀；子用例另列。

## 决策原则

- 保留可观察行为、重要异常处理、审批/权限、持久化与消息至多一次投递。
- 删除仅检查 Markdown 段落、关键词、固定措辞、颜色调用次数或缓存读取次数的断言。
- 同一行为的重复场景合并；不同的安全边界不因名字相似而删除。
- 保留真实 SDK 的离线集成回归：它们能发现简化 Mock 无法发现的事件顺序、序列化和重载问题。
- 不增加框架、通用扩展模拟器或覆盖率设施。继续使用 `node:test` 和文件内的小型 fixture。

## `tests/bar-cursor.test.mjs`（5 项）

| 原用例                                             | 决定                       | 原因 / 保留边界                                    |
| -------------------------------------------------- | -------------------------- | -------------------------------------------------- |
| loading is inert; TUI startup sets only the shape… | 保留并承接合并             | 加载无副作用、光标恢复、用户设置不被改写。         |
| non-TUI and non-TTY sessions have no effects…      | 保留并承接合并             | 非终端不输出转义字符、不消耗提示。                 |
| session replacement and a fresh extension runtime… | 合并到 loading is inert    | 同一提示持久去重，保留会话替换和扩展重载两个分支。 |
| cleanup does not write escapes if output…          | 合并到 non-TUI and non-TTY | 保留启动后终端断开的清理边界，省去重复 setup。     |
| notice persistence failure warns…                  | 保留                       | 磁盘失败仍提示并能清理，不覆盖原数据。             |

## `tests/codex-settings.test.mjs`（12 项 + 2 个子用例）

| 原用例                                                     | 决定                                    | 原因 / 保留边界                                                                         |
| ---------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| settings default off, save atomically…                     | 保留                                    | 默认关闭、原子替换、保留未知字段。                                                      |
| malformed settings are reported…                           | 保留                                    | 损坏配置不得被覆盖。                                                                    |
| stale defaults and concurrent writers…                     | 保留                                    | 乐观冲突检查、已有锁、真实并发与清理。                                                  |
| cancelled saves leave the file unchanged…                  | 保留                                    | 取消不得落盘或遗留锁。                                                                  |
| Space and Enter toggle inline…                             | 合并到 saving persists the inline value | 同一会话开关生命周期；保留两种按键、关闭后不再响应、不自动保存。                        |
| Ctrl+S saves the current value…                            | 保留                                    | 保存中去重及禁止重复应用。                                                              |
| save failure keeps the applied session value…              | 保留                                    | 持久化失败不回滚当前会话值。                                                            |
| application failure leaves the current value…              | 保留                                    | 应用失败不改状态，允许重试；不同于保存失败。                                            |
| saving persists the inline value…                          | 保留并承接合并                          | 真实文件默认值与会话值独立。                                                            |
| disposing a saving menu aborts it…                         | 保留                                    | 失效异步结果不能回写 UI 或状态。                                                        |
| Esc during saving requests cancellation…                   | 保留                                    | 用户取消保存的独立交互路径。                                                            |
| command applies Priority only to the selected Codex model… | 保留、精简断言                          | Provider/API/模型限定、历史恢复、过期菜单、写入失败和无界面模式；删除内部颜色调用序列。 |
| 子项 Cmd+Shift+F toggles session Fast…                     | 与下一项表驱动合并                      | 两个开关共用生命周期断言，仍逐个验证持久化失败、旧菜单失效、默认值不变。                |
| 子项 Cmd+Shift+P toggles session Probe…                    | 同上                                    | 额外保留 Probe 与 Fast 相互独立，不合并业务实现。                                       |

## `tests/footer-status.test.mjs`（11 项）

| 原用例                                              | 决定                      | 原因 / 保留边界                                                                     |
| --------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| footer keeps billing/context/model…                 | 保留                      | 核心信息及扩展状态分行。                                                            |
| narrow widths, wide characters…                     | 与下一项合并              | 保留宽字符、控制空白、无溢出；去掉每一个像素与全部布局的笛卡尔积。                  |
| narrow layout preserves path/branch…                | 合并为窄宽度/路径行为用例 | 保留路径缩写、宽度恢复、中文/隐藏目录/根路径与显示优先级代表场景。                  |
| usage matches cumulative session billing…           | 保留、删内部断言          | 账单跨分支/压缩累计、历史快照不变；不约束 getEntries 调用次数。                     |
| a complete run emits one snapshot…                  | 保留                      | 多轮请求只落一条统计、排除工具耗时、重复 settled 不重复写入。                       |
| each response keeps its own snapshot…               | 保留                      | 分支及历史格式恢复、不改写旧统计。                                                  |
| invalid timings and failed or empty responses…      | 保留                      | 非有限数、失败/取消、零值与旧数据降级。                                             |
| fresh requests, cancellation, and lifecycle resets… | 保留、精简组合            | 保留全部重置事件、全部 token 类型、失败/取消/工具结束；用代表组合替代无差别全排列。 |
| live model, thinking, and context warning…          | 保留                      | 模型与上下文状态变化、告警等级、缺省值。                                            |
| only TUI installs the footer…                       | 保留                      | 非 TUI 无副作用、订阅释放及重载。                                                   |
| real Pi SDK persists one snapshot…                  | 保留                      | 真实事件顺序、文件恢复、统计不进入模型上下文；Mock 用例不能替代。                   |

## `tests/gkd-fsm.test.mjs`（18 项）

| 原用例                                                      | 决定                       | 原因 / 保留边界                                                                       |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| loading is inert and only the three existing commands…      | 保留                       | 未激活时不拦截工具或普通请求。                                                        |
| FAST routes → implements → verifies…                        | 保留                       | 主状态链、非法顺序、结束后停止执行。                                                  |
| verification trusts the main Agent's report…                | 保留                       | 人工验证是合法契约，不新增执行证据门禁。                                              |
| STANDARD stays read-only until the user approves…           | 保留                       | 明确用户审批、扩展消息不能审批、任务身份检查。                                        |
| native approval is current-plan-bound…                      | 保留                       | 新计划使旧异步审批失效。                                                              |
| reported verification failure allows two automatic repairs… | 与下一项合并               | 同一修复循环，表驱动保留失败耗尽及修复成功。                                          |
| a reported failure can be repaired…                         | 合并到失败修复循环         | 保留重新实现清除旧验证；工具实际运行已由 FAST 和 SDK 用例保障。                       |
| FAST major-risk reports enter STANDARD…                     | 保留                       | 风险升级后重新审批。                                                                  |
| pause and reload preserve progress…                         | 保留                       | FAST/STANDARD 恢复差异及审批、验证失效。                                              |
| only user cancellation ends the task…                       | 保留                       | 不撤销用户代码、不可并行替换、取消后不可续跑。                                        |
| NONE/DIRECT exit development control…                       | 保留                       | 非开发退出与分类失败受阻是不同结果。                                                  |
| waiting request persists across session reload…             | 保留                       | 等待可恢复、取消清除持久授权。                                                        |
| global auto mode loads semantic Skill routing…              | 保留、去重复 STANDARD 主链 | 保留自动输入不重复发送、完成后新任务及关闭后手动启动；STANDARD 自动全链留给真实 SDK。 |
| natural language, missing parameters and overflow…          | 保留                       | 续问、超长输入不创建任务、临时工具不泄漏。                                            |
| auto mode leaves extension messages…                        | 保留                       | 注入/流式输入不触发，已有任务不得被替换或隐式恢复。                                   |
| auto NONE and DIRECT requests remain outside…               | 保留                       | 没有显式工具交接时不创建 FSM，结束恢复工具。                                          |
| auto-mode development rejects untrusted projects…           | 保留                       | 不可信目录、无模型、超长请求不得启动。                                                |
| saved state keeps the core transition…                      | 保留                       | 文件往返、非法转换和未审批 STANDARD 禁止执行。                                        |

## `tests/gkd-host.test.mjs`（1 项，5 个场景）

| 原场景                   | 决定 | 原因                                    |
| ------------------------ | ---- | --------------------------------------- |
| real Pi SDK… / 手动 FAST | 保留 | 命令交接到真实 SDK、真实工具写入/验证。 |
| 同用例 / 手动 STANDARD   | 保留 | 真实用户审批前不写文件。                |
| 同用例 / 受阻后 resume   | 保留 | 实际宿主恢复事件顺序。                  |
| 同用例 / 自动 FAST       | 保留 | 原输入和附件保留、不重复启动。          |
| 同用例 / 自动 STANDARD   | 保留 | 自动入口加审批组合、无隐藏额外请求。    |

共享同一个 SDK fixture 已足够，不再增加跨文件宿主抽象。

## `tests/gkd-settings.test.mjs`（5 项）

| 原用例                                                  | 决定 | 原因                                                          |
| ------------------------------------------------------- | ---- | ------------------------------------------------------------- |
| global settings default off, save atomically…           | 保留 | 私有权限、默认关闭、未知字段保留。                            |
| invalid settings, stale menu values and another writer… | 保留 | 损坏/冲突/锁不覆盖。                                          |
| Space/Enter save inline, Esc closes…                    | 保留 | 保存失败回滚与关闭后无响应；与 Codex 的即时会话应用语义不同。 |
| menu and Cmd+Shift+G share the global value…            | 保留 | 跨会话全局设置，不被分支历史覆盖。                            |
| shutdown disposes settings UI…                          | 保留 | 旧菜单失效、不支持模式无副作用、失败不改值。                  |

## `tests/gkd-workflow.test.mjs`（24 项，另含 3 条隐藏的脚本回归）

| 原用例 / helper                                              | 决定                                         | 原因 / 去向                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| package exposes the workflow and standalone route debugging… | 精简并拆出脚本测试                           | 保留包入口/Skill 可发现性一次 smoke 和未激活无副作用；删除所有 Skill 文案断言及重复发现检查。                     |
| verifyLarkPreflight                                          | 移到 `tests/gkd-lark.test.mjs` 独立 test     | 权限不足不得缓存、TTL、撤权、私有权限、敏感信息不落盘；不再依赖文档 smoke 先通过。                                |
| verifyLarkCreate                                             | 同上                                         | 不可信 URL 拒绝、user 身份、只建一次、不复制删除、部分成功禁止盲重试、取消和脱敏；删除模板示例措辞/字段顺序断言。 |
| verifyLarkBindings                                           | 同上                                         | 多关联、人工绑定不可降级、修订冲突/锁/并发、越界/符号链接、损坏数据不覆盖、CLI 脱敏。                             |
| PR publication skill supplies both route-specific templates… | 删除                                         | 仅匹配 Markdown 关键词及标题，不能证明发布安全。                                                                  |
| debug dispatch loads Markdown policy and workflow…           | 保留、删除措辞匹配                           | 验证系统提示保留、任务 JSON 隔离和只读工具范围，不约束策略文案。                                                  |
| Markdown instructions load independently…                    | 合并到 debug dispatch                        | 这是模块资源定位的真实行为，保留跨 cwd 子进程导入，不单独测试文档。                                               |
| route prompt separates decision, evidence and output…        | 删除                                         | 章节数/标题/关键词及示例 JSON 绑定文档排版；解析协议由行为测试保障。                                              |
| representative main-Agent assessments validate…              | 保留、精简重复例子                           | 模型结果是预置而非语义分类，保留四种路由和 DIRECT 风险等级，不重复中文任务措辞。                                  |
| DIRECT keeps operational risk and clarification…             | 保留                                         | 操作风险需审批但不变为开发规划。                                                                                  |
| intent-route mismatches cannot bypass…                       | 保留                                         | 输入契约不能绕过开发检查。                                                                                        |
| DIRECT debug never executes operations…                      | 合并到 debug blocks all non-evidence actions | 保留 DIRECT 结果后、settled 前仍只读；去掉重复 bash 命令和提示措辞检查。                                          |
| development defaults to FAST for every observation…          | 保留、缩减全排列                             | 全 true、全 false、逐项 false/true 覆盖非升级观察值；保留 FAST/STANDARD 输入纠正。                                |
| missing verification evidence does not activate planning…    | 合并到 representative main-Agent assessments | 在真实结果工具中保留 STANDARD→FAST 的归一化。                                                                     |
| explicit STANDARD triggers still upgrade…                    | 保留                                         | 每一个风险/设计触发器及中高风险都需审批。                                                                         |
| schema validation rejects malformed and oversized…           | 保留                                         | 信任边界、类型/字段/长度/非有限值检查。                                                                           |
| empty, busy, unavailable and excessive inputs…               | 保留                                         | 非法输入不分发。                                                                                                  |
| debug blocks all non-evidence actions…                       | 保留并承接 DIRECT 合并                       | 工具限制、二次启动、取消、会话失效、分发失败恢复与脱敏。                                                          |
| invalid main-Agent results produce error NONE…               | 保留                                         | 错误不冒充成功的非开发分类。                                                                                      |
| investigation finds beyond 250 paths…                        | 保留                                         | 大目录/深文件/未追踪需求、受信任门禁。                                                                            |
| investigation paginates file lists and native reads…         | 保留                                         | 分页、字节/文件大小限制、非法范围。                                                                               |
| all investigation actions exclude private paths…             | 保留                                         | 私密文件、穿越路径、二进制、可执行请求不得泄漏。                                                                  |
| investigation rejects file and directory symlinks…           | 保留                                         | 工作区外文件与历史 symlink blob 边界。                                                                            |
| Git investigation reads metadata…                            | 保留                                         | 工作树/index/HEAD 不修改，历史查询和子目录边界。                                                                  |
| Git queries never execute configured…                        | 保留                                         | 外部 diff/textconv/fsmonitor 不得执行。                                                                           |
| Git file queries handle additions, deletions…                | 保留                                         | 删除历史可读、增量、历史二进制/超大内容拒绝。                                                                     |
| investigation cancellation and session shutdown…             | 保留                                         | 异步证据过期不可回写，工具恢复。                                                                                  |

## `tests/model-probe.test.mjs`（24 项）

| 原用例                                                       | 决定                 | 原因 / 保留边界                                                                                                     |
| ------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| configuration and local Unicode/whitespace contains…         | 保留、删默认问答措辞 | 配置校验、NFKC/空白归一化、隔离强制开启；默认问题内容不是解析器契约。                                               |
| whole-file settings conflicts preserve custom questions…     | 保留                 | 整文件冲突和未知嵌套字段不能丢失，不等同于 Fast 单字段冲突。                                                        |
| native settings menu toggles Probe independently…            | 保留                 | 双开关联合保存的独立行为。                                                                                          |
| Model Probe footer follows its session toggle…               | 保留                 | 会话开关跨重载/分支、写失败、非 TUI 无渲染；不删除状态同步回归。                                                    |
| ordered multi-question probe…                                | 保留                 | 按序执行、图片和原输入保留、投递确认与重载至多一次。                                                                |
| TUI probe panel shows a concise status…                      | 精简                 | 留一个真实 renderer 场景：状态更新、日志不发送模型、已挂载不重复通知、重载不重复检测；删固定排版/每轮相同显示矩阵。 |
| TUI completion status distinguishes passed probes…           | 合并到 panel 用例    | 保留通过与用户放行显示区别；SDK 另保证 override 不伪装成 PASSED。                                                   |
| panel log persistence failure stays visible…                 | 保留                 | 状态写入失败必须关门，不发送任务。                                                                                  |
| first-input trigger honors the model allowlist…              | 保留                 | 精确 allowlist、模式/输入来源/开关/模型切换边界。                                                                   |
| startup watchdog is cleared…                                 | 保留                 | 同步启动竞态、无启动失败关闭、等待输入无超时。                                                                      |
| failure offers three actions; cancel…                        | 保留、删重复选项文案 | 取消后保留原任务、阻止工具及注入绕过、重载仍关闭。                                                                  |
| dismissed or stale failure choices…                          | 保留                 | 关闭/过期异步弹窗不能发送任务。                                                                                     |
| numbered TUI choices dispatch once…                          | 保留                 | 三种操作、粘贴/重复/释放事件不得确认、关闭后至多一次。                                                              |
| TUI navigation wraps, follows injected keybindings…          | 保留                 | 可访问键盘导航、注入键绑定、abort/dispose 只结束一次。                                                              |
| provider error, cancellation, empty answers…                 | 保留                 | 错误/取消/截断/意外工具/中断/模型变化均 fail closed；取消不自动重试。                                               |
| tree rewind cannot re-deliver…                               | 保留                 | 跨分支投递去重。                                                                                                    |
| old conversations, disabled defaults, changed configuration… | 精简重复前半段       | 旧会话不补测和开关激活已由 first-input/footer 覆盖；保留非法持久状态/selection、投递不确定不重放、fork、配置损坏。  |
| real Pi requests isolate system/tools…                       | 保留                 | 真实 SDK 最终 transform 隔离及恢复、与 GKD 共存、不匹配模型放行。                                                   |
| real Pi retries reset manual budgets…                        | 保留                 | 多轮预算边界、显式确认重置、模型/思考等级继承、原图文只投递一次。                                                   |
| real Pi explicit continue keeps the failed result…           | 保留                 | 当前会话放行不是检测通过、文件重载不重发。                                                                          |
| real persisted sessions restore PASS…                        | 保留                 | 实际文件恢复、tree/fork 拒绝、全新会话重新加载配置。                                                                |
| real Codex serializer sends empty instructions/no tools…     | 保留                 | 最终 HTTP 载荷隔离/模型/思考/Priority；SDK 高层 Mock 不能替代。fetch 本地拦截，不联网。                             |
| real Pi cancellation/no-UI failure cannot run…               | 保留                 | 耗尽预算/无 UI 不能经普通输入或 GKD 绕过，重载不重置预算。                                                          |
| first /gkd-workloop command is held…                         | 保留                 | 斜杠命令先于普通 input hook，须单独保证门禁与回放一次。                                                             |

同时删除 harness 中没有任何调用者的 stale/invalidate 测试辅助分支，不添加通用 Mock 框架。

## `extensions/gkd-workflow/pi-dev-workflow/test/workflow.test.cjs`（12 项）

该目录有自己的 package.json、命令和持久化格式，是独立可安装原型，并非已删除的业务代码。
保留行为测试，改为 `.mjs` + 原生 TypeScript strip，移除自制 CJS 编译器、SDK 常量假实现及 TypeBox 假实现；临时目录增加清理。
根 `pnpm test` 和子包测试入口均包含该文件，避免主 CI 漏跑仍保留的测试。

| 原用例                                                  | 决定 | 原因                                                    |
| ------------------------------------------------------- | ---- | ------------------------------------------------------- |
| intent gate is strict about actionable code requests…   | 保留 | 原型特有的保守自动启动门禁，不与 GKD 语义路由混为一谈。 |
| install defaults to manual…                             | 保留 | 默认不自动拦截。                                        |
| settings on/off persist, UI and status work             | 保留 | 独立原型配置格式及持久化。                              |
| auto mode handles actionable prompt…                    | 保留 | 来源/队列限制、防重启、先选模式、循环推进。             |
| STANDARD plan review blocks continuation…               | 保留 | 审批前暂停。                                            |
| disabled auto still supports forced manual FAST…        | 保留 | 手动启动、停止和恢复。                                  |
| untrusted project cannot auto-start                     | 保留 | 信任边界。                                              |
| completed without validators pauses for review…         | 保留 | 无验证不得声称通过；与主 GKD 的报告契约不同。           |
| trusted configured independent validator completes      | 保留 | 配置验证器的成功分支。                                  |
| malformed user settings fail closed…                    | 保留 | 损坏配置退回手动模式。                                  |
| auto setting OFF does not cancel an already active run  | 保留 | 开关不取消已有任务。                                    |
| global mode is re-enabled only when explicitly changed… | 保留 | 活跃 STANDARD 计划不能被自动输入覆盖。                  |

## 验证与非单元测试范围

- 修改全部完成后统一运行一次根 `pnpm test`（本任务涉及整个测试体系，包含子包），失败先定位；仅本次改动引入的问题最多重跑失败文件一次。
- 检查改动文件格式和 `git diff --check`；不重复跑全量 lint/typecheck/build，不收集覆盖率。
- Skill 文档不再写文案单元测试。实际场景验证清单：开发 FAST/需审批 STANDARD；check-lark 缓存命中/撤权；建表部分成功不重建；人工绑定不被推断覆盖；PR 发布远端/授权确认。涉及真实模型、飞书或远端发布时另行授权，本轮不将文案匹配冒充场景验证。
- 本轮不提交、不推送，不安装依赖、不访问真实飞书、不触发远端发布。

## 实施结果

- 已按以上清单实施；生产 `.ts` 文件未修改，继续使用 `node:test`，未引入依赖或通用 Mock 基础设施。
- 测试代码：5,879 → 5,472 行，减少 407 行（6.9%）；231,811 → 212,673 字节，减少 8.3%。不含本审查文档及 package.json。
- 测试文件：9 → 10 个。增加一个文件是将原先混装在文档 smoke 中的三个 Lark 脚本回归独立出来；原型测试由 `.cjs` 替换为 `.mjs`。
- 根 `pnpm test` 统一执行一次：106 项通过，0 失败、0 取消、0 跳过，约 5.0 秒（本机 Node v26.13.0；未对比旧版耗时，不宣称性能提升）。其中包含此前根入口未运行的 12 项原型测试。
- 修改范围的 `oxfmt --check`、测试文件定向 `oxlint --deny-warnings`、`git diff --check` 均通过；原型目录继续沿用既有格式/lint 排除配置。
- 未运行额外 typecheck/build/覆盖率/E2E，未做真实模型、飞书或发布联调。Skill 的实际语义效果仍须按前述场景另行验证，不能由这些离线回归证明。

## 后续：Skill 主体迁移

用户明确选择移除 Pi 强制状态机，流程、审批、验证与恢复全部交给独立 Skill。因此原分类器、状态迁移、阶段工具权限及旧状态恢复回归随对应生产功能移除，不能保留为已不存在功能的保证。

- `gkd-workflow.test.mjs` 改为将完整 Skill 复制至仓库外，验证独立发现、相对引用闭包及飞书脚本脱离仓库依赖执行；不匹配工作流文案来假装验证模型行为。
- `gkd-fsm.test.mjs` 改名为 `gkd-command.test.mjs`，复用原入口/自动模式场景，覆盖空闲门禁、隐藏 cwd、原样转发、错误不重放、自动开关与不接管工具权限。
- `gkd-host.test.mjs` 继续使用真实 Pi SDK 与离线 provider，覆盖仅 Skill、快捷命令和自动加载三条路径，检查单次投递与自动模式原消息/附件保留；不再模拟模型调用已删除的状态工具。
- `gkd-lark.test.mjs` 的三组脚本安全/持久化回归原样保留，仅更新资源路径；`gkd-settings.test.mjs` 保留设置行为回归。
- 根测试命令移除已在工作区删除的独立原型测试路径，不恢复或改动用户删除的原型文件。未新增测试文件总数或额外 `test()`；这是对变更后实际契约的替换验证。
- 审批遵守、恢复判断及飞书阶段语义由 Agent 协议约束，离线测试不能证明，真实 Codex / Claude Code 与飞书联调仍须另行验证。
- 本轮只执行上述五个 GKD 文件的相关回归一次：12 项通过，独立安装资源检查 1 项失败，定位为旧脚本入口比较未解析符号链接。三份脚本改用 Node >= 22.19.0 已支持的 `import.meta.main` 后，仅重试失败文件一次，1 项通过；未再运行整组或全量测试。
- 定向格式化、`pnpm check`（包含迁移后的 Skill 脚本）和 `git diff --check` 通过。未运行覆盖率、build、E2E、真实模型/飞书或 Model Probe 联调；未提交、推送或安装到其他 Agent。
