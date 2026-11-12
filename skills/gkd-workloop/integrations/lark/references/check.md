# 检查飞书授权

执行 `check-lark` 或用户明确要求检查飞书环境时使用。处理问题表的启动阶段也复用本流程；成功后返回原任务，**不要重新执行整个任务**。单独检查完成即结束，不读取问题表、修改代码或启动开发。

## 1. 核对参数

仅支持以下三种调用：

| 参数 | 行为 |
| --- | --- |
| 无参数 | 优先使用有效缓存；必要时检查登录与基础权限 |
| `--force` | 忽略缓存，重新检查 CLI、登录和基础权限 |
| `--invalidate` | 只清除检查缓存，不检查 CLI、不注销或发起授权 |

其他参数或参数组合直接报错并结束。三个入口都调用同一脚本；不要自行实现缓存判定。

## 2. 执行预检脚本

将 `<lark-dir>` 替换为本 Skill 的 `integrations/lark` 绝对路径，执行一条对应命令：

```bash
node --experimental-strip-types "<lark-dir>/scripts/preflight.ts"
node --experimental-strip-types "<lark-dir>/scripts/preflight.ts" --force
node --experimental-strip-types "<lark-dir>/scripts/preflight.ts" --invalidate
```

预检脚本验证缓存版本、`REQUIRED_SCOPES` 和时间。缓存未命中或使用 `--force` 时，脚本运行 `lark-cli auth status --json --verify`；验证成功才写缓存。

缓存文件：`${PI_CODING_AGENT_DIR:-~/.pi/agent}/lark-workloop/preflight.json`。包含 `version: 1`、毫秒时间戳 `checkedAt` 与基础 `scopes`。有效期为成功检查后的 **7 天**，缓存命中不续期；`expiresAt = checkedAt + 7 天`。不保存 token、密钥、授权链接或设备码。

## 3. 根据状态处理

| 返回状态 | 动作 |
| --- | --- |
| `ready` | 报告检查成功、是否命中缓存、检查时间及过期时间；返回原任务下一步 |
| `invalidated` | 报告缓存已清除；结束当前检查 |
| `missing-cli` | 提示安装官方 [lark-cli](https://github.com/larksuite/cli) 并配置 PATH；停止 |
| `needs-auth` | 执行下方授权步骤，等待用户 |
| `error` 或进程失败 | 报告实际安装、配置、网络或文件权限错误；停止，不伪造成功 |

缓存只代表**基础 scope 曾验证通过**，不代表具体 Base、表或视图具有资源 ACL 权限。

## 4. 需要授权时

1. 如果宿主有 `lark-shared`，先读取其中的身份与授权说明；否则查阅 `lark-cli` 相关帮助。确认应用已配置，不索取用户的明文密钥。
2. 根据预检返回的 `missingScopes` 发起最小范围授权；不要使用 `--domain all`：

   ```bash
   lark-cli auth login --scope "<空格分隔的 missingScopes>" --no-wait --json
   ```

3. 展示 CLI 原样返回的授权链接，并使用 `lark-cli auth qrcode` 生成二维码。**先展示链接和二维码，再交还控制权**；不得阻塞等待导致用户无法查看。
4. 告知用户完成授权后回复。记录原任务和当前待续步骤，在本回合停止后续操作。
5. 用户确认授权后，按 CLI 帮助执行 `lark-cli auth login --device-code <本次设备码>`，再运行预检脚本 `--force`；成功后只恢复尚未完成的步骤。

设备码和授权链接只保留当前授权步骤所需的会话上下文，不写入缓存、项目文件或长期摘要。CLI 提示缺 `refresh_token` 时按实际过期时间与管理员设置解释，不将预检的 7 天缓存误当作登录有效期。

## 5. 缓存失效与恢复

- 认证失败、缺 scope、CLI 无法使用时，即使未满 7 天也运行预检脚本 `--invalidate`，再按真实错误恢复。
- 切换 CLI 账号、应用或 profile 后使用 `--force`；缓存不会自动识别身份切换。
- 资源 ACL 拒绝应检查资源权限，不重复申请 OAuth scope。
- 网络错误不等于未登录，不反复触发扫码；缓存保存失败也必须按失败处理。
- 恢复时只继续未完成步骤，不自动启动未请求的建表、开发或处理任务。
