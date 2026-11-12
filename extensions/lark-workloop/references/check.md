# check：CLI 安装与用户授权

当用户明确调用 `/lark-workloop check`、`/skill:lark-workloop check`，或总入口将本次自然语言操作分发为 check 步骤时执行本节。检查与必要授权引导属于此子流程，不属于总入口的意图识别。work 的启动阶段也复用本节检查与授权恢复机制，检查成功后返回当前 work 步骤继续，不重新派发或重放整个命令。每步结束后返回已有调度计划；单独 check 则报告后结束。检查本身不读取问题表、不询问业务应用绑定、不修改代码、不自行启动处理 loop。

成功检查保存在 `${PI_CODING_AGENT_DIR:-~/.pi/agent}/lark-workloop/preflight.json`：`version: 1`、毫秒时间戳 `checkedAt`、已确认的基础 `scopes`。默认失效时间为 **7 天**，从成功复检完成时算起，不因缓存命中续期。

1. 由当前主 Agent 先核对当前步骤的参数：无参数、`--force` 或 `--invalidate`，不接受其他值或组合。快捷入口、原生 skill 和自然语言分发统一按以下步骤执行；入口不会预先检查或注入检查结果。只复用当前步骤的本次结果，不把先前步骤、表格、附件或旧记录的状态当作本次检查。
   - `--invalidate`：仅运行本节的清缓存命令，返回 `invalidated` 后记录当前步骤完成并返回调度，不检查 CLI、不发起授权，也不注销登录。
   - `--force`：直接运行脚本 `--force`，不因缓存有效而跳过。
   - 无参数：先读取成功缓存；版本正确、时间不在未来且距当前不足 7 天、权限集覆盖技能根目录 `scripts/preflight.ts` 的 `REQUIRED_SCOPES` 时，可以跳过 TS 脚本与 CLI 复检；由主 Agent 按以上条件判断是否复用，不调用 CLI。
2. 缓存缺失、过期、损坏、权限集变化，或用户明确要求重新检查时，运行（`<skill-dir>` 是本技能目录的真实路径）：

   ```bash
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts"
   # 授权完成、切换 CLI 账号/应用/profile 或用户要求复检时：
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts" --force
   ```

   脚本通过 `lark-cli auth status --json --verify` 同时确认 CLI 可执行、用户登录已被服务端验证，以及 Base 读取/回写、Wiki/电子表格定位和附件下载的基础 scopes。仅完整成功才写缓存；不存 token、密钥、授权 URL 或 device code。基础权限通过不代表具体表格的资源访问权限已经通过。

3. `missing-cli`：明确提示安装官方 lark-cli 并配置 PATH 后重新调用，停止本轮；不自动安装，不改用 bot、浏览器或其他集成绕过检查。官方安装说明：https://github.com/larksuite/cli 。缓存有效期间 CLI 被卸载时，后续命令失败同样使缓存失效。
4. `needs-auth`：先读取 `lark-shared` 及身份/权限参考；没有独立 skill 时可按 CLI 帮助读取内嵌说明。核对应用是否已配置，按说明引导用户，不索取明文密钥。不用 `--domain all`：基于本次 `missingScopes` 发起最小范围授权：

   ```bash
   lark-cli auth login --scope "<空格分隔的 missingScopes>" --no-wait --json
   ```

   当前步骤记录为 `waiting_user`，暂停所有后续步骤。将原样授权链接和通过 `lark-cli auth qrcode` 生成的二维码展示给用户，明确告知“请完成授权后回来告诉我”，然后交还控制权；不能在用户看见链接前阻塞等待。用户确认后由 agent 在后续回合执行 `auth login --device-code <本次设备码>`，再运行脚本 `--force`。不要把授权链接和设备码存进检查缓存或跨流程复用。若 CLI 提示没有 refresh_token，按参考说明真实失效时间及管理员需完成的设置，不把一周缓存当作 token 有效期。

5. `error`、执行失败或无法保存缓存：报告安装/配置/网络/本地权限问题，停止处理；不能伪造授权成功时间，也不要将网络故障当作用户未登录而反复发起授权。
6. `ready`：报告检查通过、是否命中缓存、检查时间和失效时间，记录本步 `completed`，返回调度计划。只有计划中已被用户明确请求的后续步骤才可继续，不自动追加处理流程。认证、缺 scope 或 CLI 不可用错误一旦出现，即使缓存未满一周也要立即执行 `--invalidate` 清除缓存，再按实际原因恢复；资源 ACL 拒绝不能通过重复申请 OAuth scope 解决。切换 CLI 账号、应用或 profile 后须 `--force`，缓存不是账号切换检测器。

   ```bash
   node --experimental-strip-types "<skill-dir>/scripts/preflight.ts" --invalidate
   ```

CLI 调用结果中缓存时间采用毫秒，`expiresAt` 为 `checkedAt + 7 天`；缓存只证明最近一次基础检查成功，不替代实际接口鉴权、用户授权开关和每条问题的权限检查。

未知参数先报告用法，不能忽略后继续检查。`missing-cli` 或 `error` 等失败须记录本步状态并暂停后续步骤，恢复时不得重放已经完成的前序操作。
