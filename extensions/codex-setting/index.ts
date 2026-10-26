import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createSettingsMenu } from "./menu.ts";
import { readSettings, saveSettings } from "./settings.ts";

const SESSION_ENTRY = "codex-setting";

export default function (pi: ExtensionAPI) {
  const settingsPath = join(getAgentDir(), "codex-setting.json");
  let defaultFast = false;
  let fast = false;
  let menuVersion = 0;
  let closeMenu: (() => void) | undefined;

  function invalidateMenu() {
    menuVersion++;
    const close = closeMenu;
    closeMenu = undefined;
    close?.();
  }

  function updateStatus(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    // shortcut: setStatus stores ANSI text; reload after changing the Pi theme.
    const showFast = fast && ctx.model?.provider === "openai-codex" && ctx.model.api === "openai-codex-responses";
    ctx.ui.setStatus(SESSION_ENTRY, showFast ? ctx.ui.theme.fg("dim", "| Codex Fast |") : undefined);
  }

  function applyFast(value: boolean, ctx: ExtensionContext) {
    pi.appendEntry(SESSION_ENTRY, { fast: value });
    fast = value;
    updateStatus(ctx);
  }

  async function restore(ctx: ExtensionContext) {
    invalidateMenu();
    const version = menuVersion;
    let loadedDefault = false;
    try {
      ({ fast: loadedDefault } = await readSettings(settingsPath));
    } catch (error) {
      if (version !== menuVersion) return;
      ctx.ui.notify(
        `Cannot load Codex settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    if (version !== menuVersion) return;
    defaultFast = loadedDefault;
    fast = defaultFast;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY) continue;
      const data: unknown = entry.data;
      if (data && typeof data === "object" && "fast" in data && typeof data.fast === "boolean") {
        fast = data.fast;
      }
    }
    updateStatus(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", invalidateMenu);
  pi.on("model_select", (_event, ctx) => {
    invalidateMenu();
    updateStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (
      !fast ||
      ctx.model?.provider !== "openai-codex" ||
      ctx.model.api !== "openai-codex-responses" ||
      !payload ||
      typeof payload !== "object" ||
      !("model" in payload) ||
      payload.model !== ctx.model.id
    ) {
      return;
    }
    return { ...payload, service_tier: "priority" };
  });

  pi.registerShortcut("super+shift+f", {
    description: "Toggle Codex Fast (Priority) mode",
    handler: (ctx) => {
      if (ctx.mode !== "tui") return;
      invalidateMenu();
      applyFast(!fast, ctx);
      ctx.ui.notify(`Codex Fast: ${fast ? "on" : "off"}`, "info");
    },
  });

  pi.registerCommand("codex-setting", {
    description: "Configure Codex Fast (Priority) mode",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/codex-setting requires TUI mode", "error");
        return;
      }
      invalidateMenu();
      const version = menuVersion;
      const sessionId = ctx.sessionManager.getSessionId();
      const selection = { provider: ctx.model?.provider, id: ctx.model?.id };
      function checkCurrent() {
        if (
          version !== menuVersion ||
          sessionId !== ctx.sessionManager.getSessionId() ||
          selection.provider !== ctx.model?.provider ||
          selection.id !== ctx.model?.id
        ) {
          throw new Error("The session or selected model changed. Reopen /codex-setting.");
        }
      }
      let close: (() => void) | undefined;
      try {
        let { fast: expectedFast } = await readSettings(settingsPath);
        checkCurrent();
        defaultFast = expectedFast;
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          checkCurrent();
          const menu = createSettingsMenu(tui, theme, keybindings, {
            fast,
            defaultFast,
            onApply(value) {
              checkCurrent();
              applyFast(value, ctx);
            },
            async onSave(value, signal) {
              checkCurrent();
              await saveSettings(settingsPath, value, expectedFast, signal);
              expectedFast = value;
              if (version === menuVersion && !signal.aborted) defaultFast = value;
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
        if (version === menuVersion) {
          ctx.ui.notify(
            `Cannot open Codex settings: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      } finally {
        if (closeMenu === close) closeMenu = undefined;
        close?.();
      }
    },
  });
}
