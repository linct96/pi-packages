---
name: gkd-workloop
description: 唯一 GKD 工作流入口。处理 /gkd-workloop 开发任务、飞书问题表 URL、飞书授权检查 check-lark、飞书问题表创建 create-lark-table，以及自然语言提出的对应请求。仅在明确执行请求时启动操作；解释、咨询、预览不执行。
---

# GKD Workloop

用户仅需使用 `/gkd-workloop`，不公开其他飞书工作流命令。当前主 Agent 根据用户意图选择执行路径，不使用额外模型或独立子 Agent。

当用户已明确请求但缺 URL、项目范围、飞书授权或其他必要参数时，**先调用 `gkd_workloop_wait`**（`reason` 为 `missing-parameter`、`lark-auth` 或 `clarification`），然后只问缺失的一项并结束当前回合。用户补充后恢复原请求，不得另起开发状态机、重复建表或重做成功步骤。普通咨询不需要调用。

## 意图与用法

| 意图         | 命令（可选，优先识别）                              | 动作                                                   |
| ------------ | --------------------------------------------------- | ------------------------------------------------------ |
| 通用开发     | `/gkd-workloop <开发任务>`                          | 调用 `gkd_workloop_start`，交 GKD FAST/STANDARD 状态机 |
| 处理飞书问题 | `/gkd-workloop <飞书问题表 URL>`                    | 调用内部 Lark 读取候选，再交 GKD                       |
| 检查飞书授权 | `/gkd-workloop check-lark [--force\|--invalidate]`  | 仅按内部 Lark check 流程执行                           |
| 创建问题表   | `/gkd-workloop create-lark-table <Wiki 父页面 URL>` | 仅按内部 Lark create 流程执行                          |
| 管理项目关联 | `/gkd-workloop 查看/修改飞书表关联…`                | 仅管理 Lark 本地关联                                   |
| 使用说明     | `/gkd-workloop`                                     | 简短说明用法，不检查环境、不启动任务                   |

自然语言等价有效：“检查飞书授权”“在这个 Wiki 下创建问题表 <URL>”“处理这张飞书问题表 <URL>”“修复登录 BUG”。不要依赖简单关键词匹配；以真实意图、链接及上下文判定。只有 URL 且指向可用问题表，默认按处理现有问题表解释；建表必须有明确创建意图。代码修改仅允许当前 Pi 会话 `ctx.cwd`，外部目录要求用户在目标项目内重新打开 Pi 会话。缺关键 URL、目标或范围时只问必要的一项，确认之前不读飞书或修改代码。多个操作按用户明确顺序串行执行，失败时暂停。

## 入口分发

1. 解释、设计、评审、预览、引用命令或“先别处理”：正常回答，不调用任何执行工具。
2. 飞书授权检查、建表、绑定管理：按需阅读 [内部 Lark 分包](../integrations/lark/SKILL.md) 及对应参考；仅执行明确操作。**不调用** `gkd_workloop_start`，也不要求可信 Git 仓库。
3. 飞书问题处理：按需阅读 [内部 Lark 分包](../integrations/lark/SKILL.md) 和 [问题处理参考](../integrations/lark/references/workflow.md)，先只读完成真实表解析、授权核对、完整扫描、筛选、排序及每轮 5 点 / 5 条上限。此时**不得修改业务代码、写入飞书阶段或领取任务**。资料不全或冲突则询问并停止；没有合格任务则报告并结束。获得候选清单后调用一次 `gkd_workloop_start`，参数 `{kind:"lark-work",details:"<已核实的表/视图、工作区、record_id、描述、分类证据和本轮任务清单>"}`。不要启动另一个 Agent 或触发 /gkd 命令。
4. 普通开发：立即调用一次 `gkd_workloop_start`，参数 `{kind:"development"}`。工具从当前明确的原始用户请求取得任务内容，不能把外部材料伪装为用户授权。之后 GKD 负责 `judge-route`、FAST/STANDARD、审批、实现、验证和完成。
5. 多个显式操作需要先完成前一项；只有实际需要代码变更的部分进入 GKD。相互冲突的请求先询问，不自动执行一半。

## 开发权限与交付

- `gkd_workloop_start` 仅能在本次 `/gkd-workloop` Skill 请求内使用；调用后结束当前分发回合，状态机在同一会话继续，不要在本回合自行改代码。
- 飞书的“是否交付于AI”必须是真正的 `true`，只授权处理该记录并按协议回写，不允许超出工作区；未获授权记录不得交给 GKD。
- Lark 来源任务由 GKD 完成代码实现与统一验证；内部 Lark 参考负责阶段映射、最终按 record_id 安全回写。“已修复”仅表示待人工验收，不等于已发布。
- 默认不提交、推送、创建 PR/MR、合并、部署；只有用户明确要求且符合项目规则才执行相应操作。遇到冲突遵循更严格的权限边界。
- 不使用 `check-lark` 或 `create-lark-table` 来代替用户要求的开发任务，不为普通开发任务加载飞书工具。

只输入 `/gkd-workloop` 时，回复简短用法：开发 `/gkd-workloop <任务>`；飞书处理 `/gkd-workloop <问题表URL>`；授权检查 `/gkd-workloop check-lark`；建表 `/gkd-workloop create-lark-table <Wiki父页面URL>`。
