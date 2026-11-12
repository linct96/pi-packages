import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const skillPath = fileURLToPath(new URL("../../skills/gkd-workloop/SKILL.md", import.meta.url));

/** Auto mode loads the same portable Skill without rewriting the user's text or attachments. */
export function registerWorkloopAuto(
  pi: ExtensionAPI,
  enabled: (ctx: ExtensionContext) => boolean,
) {
  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user") return;
    const text = event.prompt.trim();
    if (!text || /^[!/]/.test(text) || text.startsWith("<skill ")) return;
    try {
      if (!enabled(ctx)) return;
      return {
        systemPrompt: `${event.systemPrompt}\n\n<skill name="gkd-workloop" location=${JSON.stringify(skillPath)}>\nReferences are relative to ${dirname(skillPath)}.\n${readFileSync(skillPath, "utf8")}\n</skill>`,
      };
    } catch (error) {
      ctx.ui.notify(`无法自动加载 GKD Skill：${String(error)}`, "error");
    }
  });
}
