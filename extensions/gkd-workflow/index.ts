import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettings } from "./settings.ts";
import { registerWorkflow } from "./workflow.ts";

export default function (pi: ExtensionAPI) {
  const autoEnabled = registerSettings(pi);
  registerWorkflow(pi, autoEnabled);
}
