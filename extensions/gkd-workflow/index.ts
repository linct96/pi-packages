import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJudgeRoute } from "./judge-route/index.ts";

export default function (pi: ExtensionAPI) {
  registerJudgeRoute(pi);

  pi.registerCommand("gkd", {
    description: "gkd-workflow 工作流入口（待实现）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        "gkd-workflow：工作流入口已就绪，具体流程尚未实现。个人设置请使用 /gkd-settings。",
        "info",
      );
    },
  });

  pi.registerCommand("gkd-settings", {
    description: "gkd-workflow 全局个人设置（暂无设置项）",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        "gkd-workflow：后续个人设置将全局生效，跨项目、跨会话共用；当前暂无可配置项。",
        "info",
      );
    },
  });
}
