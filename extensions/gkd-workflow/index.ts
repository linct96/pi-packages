import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSettings } from "./settings.ts";
import { registerWorkloopCommand } from "./command.ts";
import { registerWorkloopAuto } from "./auto.ts";

export default function (pi: ExtensionAPI) {
  const autoEnabled = registerSettings(pi);
  registerWorkloopCommand(pi);
  registerWorkloopAuto(pi, autoEnabled);
}
