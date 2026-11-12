# check：CLI 安装与用户授权

由 `/gkd-workloop` 主入口识别 `check-lark` 或自然语言检查飞书授权请求时执行本节。内部集成不注册独立用户命令。检查与必要授权引导属于此子流程，不属于总入口的意图识别。work 的启动阶段也复用本节检查与授权恢复机制，检查成功后返回当前 work 步骤继续，不重新派发或重放整个命令。每步结束后返回已有调度计划；单独 check 则报告后结束。检查本身不读取问题表、不询问业务应用绑定、不修改代码、不自行启动处理 loop。

成功检查保存在 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lark-workloop/preflight.json`：`version: 1`、毫秒时间戳 `checkedAt`、已确认的基础 `scopes`。默认失效时间为 **7 天**，从成功复检完成时算起，不因缓存命中续期。

1. 先确认参数只能为无参数、`--force` 或 `--invalidate`，不接受其他值或组合。参数不合法时报告用法并停止；所有入口统一调用同一脚本，由脚本判定缓存和 CLI 状态。
2. 按本次参数执行以下命令之一（`<skill-dir>` 是本 Skill 内 `integrations/lark` 目录的真实路径）：

   ```bash
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts"
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts" --force
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts" --invalidate
   ```

   - 无参数：由脚本判断缓存是否有效；命中时返回 `ready` 且 `cached: true`，不再调用 CLI。缓存版本、时间及 `REQUIRED_SCOPES` 的校验只在脚本中维护，Agent 不重复实现。
   - `--force`：忽略缓存并调用 CLI 重新验证登录与基础权限。
   - `--invalidate`：仅运行脚本清缓存，收到 `invalidated` 后完成本步骤并返回调度，不检查 CLI、不发起授权、不注销登录。

   只有需要复检时，脚本才调用 `lark-cli auth status --json --verify` 核实 CLI、登录和基础 scopes；仅成功时写入缓存。缓存不存 token、密钥、授权链接或设备码，基础权限通过不代表具体表格的资源 ACL 已通过。

3. `missing-cli`：明确提示安装官方 lark-cli 并配置 PATH 后重新调用，停止本轮；不自动安装，不改用 bot、浏览器或其他集成绕过检查。官方安装说明：https://github.com/larksuite/cli 。缓存有效期间 CLI 被卸载时，后续命令失败同样使缓存失效。
4. `needs-auth`：宿主有 `lark-shared` 时先读取其身份/权限参考；没有时按 CLI 帮助读取内嵌说明。核对应用是否已配置，按说明引导用户，不索取明文密钥。不用 `--domain all`：基于本次 `missingScopes` 发起最小范围授权：

   ```bash
   lark-cli auth login --scope "<空格分隔的 missingScopes>" --no-wait --json
   ```

   在当前会话记录原请求、已完成步骤和本次授权待续步骤，将当前步骤标为等待用户，然后暂停所有后续步骤。将原样授权链接和通过 `lark-cli auth qrcode` 生成的二维码展示给用户，明确告知“请完成授权后回来告诉我”，然后交还控制权；不能在用户看见链接前阻塞等待。用户确认后由 agent 在后续回合执行 `auth login --device-code <本次设备码>`，再运行脚本 `--force`。不要把授权链接和设备码存进检查缓存或跨流程复用。若 CLI 提示没有 refresh_token，按参考说明真实失效时间及管理员需完成的设置，不把一周缓存当作 token 有效期。

5. `error`、执行失败或无法保存缓存：报告安装/配置/网络/本地权限问题，停止处理；不能伪造授权成功时间，也不要将网络故障当作用户未登录而反复发起授权。
6. `ready`：报告检查通过、是否命中缓存、检查时间和失效时间，记录本步 `completed`，返回调度计划。只有计划中已被用户明确请求的后续步骤才可继续，不自动追加处理流程。认证、缺 scope 或 CLI 不可用错误一旦出现，即使缓存未满一周也要立即执行 `--invalidate` 清除缓存，再按实际原因恢复；资源 ACL 拒绝不能通过重复申请 OAuth scope 解决。切换 CLI 账号、应用或 profile 后须 `--force`，缓存不是账号切换检测器。

   ```bash
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts" --invalidate
   ```

CLI 调用结果中缓存时间采用毫秒，`expiresAt` 为 `checkedAt + 7 天`；缓存只证明最近一次基础检查成功，不替代实际接口鉴权、用户授权开关和每条问题的权限检查。

未知参数先报告用法，不能忽略后继续检查。`missing-cli` 或 `error` 等失败须记录本步状态并暂停后续步骤，恢复时不得重放已经完成的前序操作。
