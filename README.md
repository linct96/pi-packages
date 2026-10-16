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

快捷键沿用 Pi 的 `tui.select.*` 和 `app.models.save` 配置；如果你重绑了模型选择器的保存键，这里也会随之变化。

Fast 默认为 `off`。`on` 为当前选中的 `openai-codex` / `openai-codex-responses` 模型请求设置 `service_tier: "priority"`，不改变模型、推理强度或其他请求字段；`off` 不改写请求，不会清理其他配置或插件自行设置的 tier。不会改写其他 provider、不同模型或虚拟模型路由后的请求。

启用后，Pi 底部状态栏显示 `Codex Fast`；关闭时移除。恢复会话和分支导航时同步显示状态。该标记表示开关已开启，不表示服务端已确认 Priority；非 Codex 请求仍不受影响。使用原生扩展状态接口，不替换现有底栏；自定义底栏需支持显示扩展状态。

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

## 目录约定

```text
extensions/
  codex-setting/
    index.ts           # /codex-setting 命令、会话状态与请求钩子
    menu.ts            # 原生设置列表与 Fast 行内切换
    settings.ts        # 全局默认值读写
tests/
  codex-setting.test.mjs
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