import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const noticePath = join(getAgentDir(), "bar-cursor-notice-shown");
  let active = false;

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !process.stdout.isTTY || active) return;
    active = true;
    process.stdout.write("\x1b[5 q");
    try {
      await mkdir(dirname(noticePath), { recursive: true });
      try {
        await writeFile(noticePath, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        throw error;
      }
    } catch (error) {
      ctx.ui.notify(`无法记录竖线光标提示状态，下次启动可能再次提示：${String(error)}`, "warning");
    }
    ctx.ui.notify(
      "竖线光标：请在 /settings 中将 Show hardware cursor 设为 true；若已开启，无需操作。",
      "info",
    );
  });

  pi.on("session_shutdown", () => {
    if (!active) return;
    active = false;
    // shortcut: reset to the terminal default, not the previous shape; query it only if exact restoration is needed.
    if (process.stdout.isTTY) process.stdout.write("\x1b[0 q");
  });
}
