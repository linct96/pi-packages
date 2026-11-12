import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deferWorkloopForProbe } from "../codex-settings/model-probe/index.ts";

/** Keep the slash command free of business logic; the main Skill performs semantic routing. */
export function registerWorkloopCommand(pi: ExtensionAPI) {
  pi.registerCommand("gkd-workloop", {
    description: "统一工作流：开发任务、飞书问题表、check-lark、create-lark-table；支持自然语言",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input) {
        ctx.ui.notify(
          "用法：/gkd-workloop <任务或飞书表URL> | check-lark | create-lark-table <Wiki父页面URL>",
          "info",
        );
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        pi.sendMessage(
          {
            customType: "gkd-workloop",
            content: "操作未开始：Agent 正忙或存在待处理消息，请在当前任务结束后重新调用。",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }
      if (deferWorkloopForProbe(`/gkd-workloop ${input}`, ctx)) return;
      try {
        pi.sendMessage(
          {
            customType: "gkd-workloop-context",
            content: `\n\n[gkd-workloop 当前会话]\n${JSON.stringify({ cwd: ctx.cwd })}`,
            display: false,
          },
          { triggerTurn: false },
        );
        pi.sendUserMessage(`/skill:gkd-workloop ${input}`, {
          expandPromptTemplates: true,
          deliverAs: "followUp",
        });
      } catch {
        pi.sendMessage(
          {
            customType: "gkd-workloop",
            content: "分发未完成：请检查当前会话状态后重新调用 /gkd-workloop。",
            display: true,
          },
          { triggerTurn: false },
        );
      }
    },
  });
}
