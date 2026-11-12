import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 快捷入口只交接请求，命令识别、参数校验与分发统一由 Skill 完成。
export default function larkWorkloop(pi: ExtensionAPI) {
  pi.registerCommand("lark-workloop", {
    description:
      "飞书问题工作流：check 检查授权；create <URL> 创建漏洞表；work --larkurl <问题表URL> [--workspace <工作区路径>] 处理问题",
    handler: async (args, ctx) => {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        pi.sendMessage(
          {
            customType: "lark-workloop",
            content:
              "操作未开始：Agent 正忙或有待处理消息。\n请等待当前任务结束后重新调用 /lark-workloop。",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }
      try {
        const input = args.trim();
        const context = `\n\n[lark-workloop 当前会话]\n${JSON.stringify({ cwd: ctx.cwd })}`;
        pi.sendMessage(
          { customType: "lark-workloop-context", content: context, display: false },
          { triggerTurn: false },
        );
        pi.sendUserMessage(`/skill:lark-workloop ${input}`, {
          expandPromptTemplates: true,
        });
      } catch {
        pi.sendMessage(
          {
            customType: "lark-workloop",
            content:
              "分发未完成：未能确认主 Agent 已接收请求。\n请核对当前任务状态后再调用 /lark-workloop。",
            display: true,
          },
          { triggerTurn: false },
        );
      }
    },
  });
}
