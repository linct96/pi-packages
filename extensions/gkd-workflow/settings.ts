import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  DynamicBorder,
  getAgentDir,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, type TUI } from "@earendil-works/pi-tui";

export function readSettings(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { autoEnabled: false };
    throw error;
  }
  const settings: unknown = JSON.parse(text);
  if (
    !settings ||
    typeof settings !== "object" ||
    !("autoEnabled" in settings) ||
    typeof settings.autoEnabled !== "boolean"
  ) {
    throw new Error(`Invalid GKD settings in ${path}: autoEnabled must be a boolean`);
  }
  return { ...settings, autoEnabled: settings.autoEnabled };
}

export function saveSettings(path: string, autoEnabled: boolean, expected: boolean) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const lock = openSync(lockPath, "wx", 0o600);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const current = readSettings(path);
    if (current.autoEnabled !== expected)
      throw new Error("GKD settings changed on disk. Reopen /gkd-settings.");
    const fd = openSync(temporaryPath, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ...current, autoEnabled }, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // shortcut: non-cooperating external editors can race rename; use the menu/shortcut to change this file.
    renameSync(temporaryPath, path);
  } finally {
    try {
      rmSync(temporaryPath, { force: true });
    } finally {
      try {
        closeSync(lock);
      } finally {
        rmSync(lockPath);
      }
    }
  }
}

export function createSettingsMenu(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  options: {
    autoEnabled: boolean;
    onApply(value: boolean): void;
    onClose(): void;
  },
) {
  const value = (enabled: boolean) => (enabled ? "on" : "off");
  let disposed = false;
  const status = new Text("", 0, 0);
  const list = new SettingsList(
    [
      {
        id: "autoEnabled",
        label: "自动启用 GKD",
        currentValue: value(options.autoEnabled),
        values: ["off", "on"],
        description:
          "普通输入自动加载 GKD Skill；全局生效并立即保存。主输入区按 Cmd+Shift+G 切换，不代替用户审批或恢复任务。",
      },
    ],
    1,
    getSettingsListTheme(),
    (_id, selected) => {
      try {
        options.onApply(selected === "on");
        options.autoEnabled = selected === "on";
        status.setText(theme.fg("muted", "已保存，全局生效"));
      } catch (error) {
        list.updateValue("autoEnabled", value(options.autoEnabled));
        status.setText(theme.fg("error", `保存失败：${String(error)}`));
      }
    },
    () => {
      disposed = true;
      options.onClose();
    },
  );
  const container = new Container();
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold("GKD Settings")), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(list);
  container.addChild(status);
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    dispose() {
      disposed = true;
    },
    handleInput(data: string) {
      if (disposed) return;
      list.handleInput(data);
      if (!disposed) tui.requestRender();
    },
    handleMouse(event: Parameters<SettingsList["handleMouse"]>[0]) {
      return disposed ? { handled: true } : container.handleMouse(event);
    },
  };
}

export function registerSettings(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "gkd-workflow.json");
  let closeMenu: (() => void) | undefined;
  let version = 0;
  function invalidateMenu() {
    version++;
    closeMenu?.();
    closeMenu = undefined;
  }
  function updateStatus(ctx: ExtensionContext, enabled: boolean) {
    ctx.ui.setStatus("gkd-auto", enabled ? "GKD Auto · on" : undefined);
  }
  function enabled(ctx: ExtensionContext) {
    const value = readSettings(path).autoEnabled;
    updateStatus(ctx, value);
    return value;
  }
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    invalidateMenu();
    try {
      enabled(ctx);
    } catch (error) {
      updateStatus(ctx, false);
      ctx.ui.notify(`无法读取 GKD 设置：${String(error)}`, "error");
    }
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("session_shutdown", invalidateMenu);
  pi.registerShortcut("super+shift+g", {
    description: "切换自动启用 GKD（全局保存）",
    handler(ctx) {
      if (ctx.mode !== "tui") return;
      invalidateMenu();
      try {
        const current = readSettings(path).autoEnabled;
        saveSettings(path, !current, current);
        updateStatus(ctx, !current);
        ctx.ui.notify(`GKD 自动启用：${!current ? "开启" : "关闭"}（已全局保存）`, "info");
      } catch (error) {
        ctx.ui.notify(`无法保存 GKD 设置：${String(error)}`, "error");
      }
    },
  });
  pi.registerCommand("gkd-settings", {
    description: "GKD 全局个人设置",
    async handler(_args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/gkd-settings 需要 TUI 模式", "error");
        return;
      }
      invalidateMenu();
      const currentVersion = version;
      const sessionId = ctx.sessionManager.getSessionId();
      let close: (() => void) | undefined;
      try {
        let current = readSettings(path).autoEnabled;
        updateStatus(ctx, current);
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          function checkCurrent() {
            if (version !== currentVersion || sessionId !== ctx.sessionManager.getSessionId())
              throw new Error("会话已变化，请重新打开 /gkd-settings。");
          }
          checkCurrent();
          const menu = createSettingsMenu(tui, theme, keybindings, {
            autoEnabled: current,
            onApply(value) {
              checkCurrent();
              saveSettings(path, value, current);
              current = value;
              updateStatus(ctx, value);
            },
            onClose: () => close?.(),
          });
          let closed = false;
          close = () => {
            if (closed) return;
            closed = true;
            menu.dispose();
            done();
          };
          closeMenu = close;
          return menu;
        });
      } catch (error) {
        if (version === currentVersion)
          ctx.ui.notify(`无法打开 GKD 设置：${String(error)}`, "error");
      } finally {
        if (closeMenu === close) closeMenu = undefined;
        close?.();
      }
    },
  });
  return enabled;
}
