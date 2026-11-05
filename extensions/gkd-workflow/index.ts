import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJudgeRoute } from "./judge-route/index.ts";

export default function (pi: ExtensionAPI) {
  const { startWorkflow } = registerJudgeRoute(pi);

  pi.registerCommand("gkd", {
    description: "GKD 工作流：先 judge-route，再执行开发并按 FAST/STANDARD 生成 PR/MR",
    handler: (args, ctx) => startWorkflow(args, ctx),
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
