import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let restoreHardwareCursor: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !process.stdout.isTTY || restoreHardwareCursor) return;
    ctx.ui.setWidget("bar-cursor", (tui) => {
      const previous = tui.getShowHardwareCursor();
      let active = true;
      tui.setShowHardwareCursor(true);
      restoreHardwareCursor = () => {
        active = false;
        ctx.ui.setWidget("bar-cursor", undefined);
        tui.setShowHardwareCursor(previous);
      };
      return {
        render: () => {
          // /reload reapplies saved settings after session_start; repair before Pi resolves fake cursors.
          if (active && !tui.getShowHardwareCursor()) tui.setShowHardwareCursor(true);
          return [];
        },
        invalidate() {},
      };
    });
    process.stdout.write("\x1b[5 q");
  });

  pi.on("session_shutdown", () => {
    if (!restoreHardwareCursor) return;
    const restore = restoreHardwareCursor;
    restoreHardwareCursor = undefined;
    restore();
    // shortcut: reset to the terminal default, not the previous shape; query it only if exact restoration is needed.
    if (process.stdout.isTTY) process.stdout.write("\x1b[0 q");
  });
}
