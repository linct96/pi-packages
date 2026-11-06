import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, Text } from "@earendil-works/pi-tui";

export const FAILURE_OPTIONS = [
  "重新创建会话并发送消息",
  "继续当前会话并发送消息",
  "取消",
] as const;
const TITLE = "模型检测未通过，请选择后续操作";

export async function selectFailureAction(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return;
  if (ctx.mode !== "tui") return ctx.ui.select(TITLE, [...FAILURE_OPTIONS], { signal });
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    let selected = 0;
    let closed = false;
    function finish(choice?: string) {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", cancel);
      done(choice);
    }
    function cancel() {
      finish();
    }
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    return {
      render(width) {
        return [
          ...new Text(theme.fg("accent", TITLE), 1, 0).render(width),
          "",
          ...FAILURE_OPTIONS.flatMap((label, index) =>
            new Text(
              theme.fg(
                index === selected ? "accent" : "text",
                `${index === selected ? "❯" : " "} ${index + 1}. ${label}`,
              ),
              1,
              0,
            ).render(width),
          ),
        ];
      },
      handleInput(data) {
        if (closed || isKeyRelease(data) || isKeyRepeat(data)) return;
        if (keybindings.matches(data, "tui.select.cancel")) cancel();
        else if (keybindings.matches(data, "tui.select.up")) {
          selected = (selected + FAILURE_OPTIONS.length - 1) % FAILURE_OPTIONS.length;
          tui.requestRender();
        } else if (keybindings.matches(data, "tui.select.down")) {
          selected = (selected + 1) % FAILURE_OPTIONS.length;
          tui.requestRender();
        } else if (keybindings.matches(data, "tui.input.newLine")) return;
        else if (
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.input.submit")
        )
          finish(FAILURE_OPTIONS[selected]);
        else {
          const index = (["1", "2", "3"] as const).findIndex((key) => matchesKey(data, key));
          if (index >= 0) finish(FAILURE_OPTIONS[index]);
        }
      },
      invalidate() {},
      dispose() {
        cancel();
      },
    };
  });
}
