import {
  DynamicBorder,
  getSettingsListTheme,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";

interface MenuOptions {
  fast: boolean;
  defaultFast: boolean;
  onApply(fast: boolean): void;
  onSave(fast: boolean, signal: AbortSignal): Promise<void>;
  onClose(): void;
}

export function createSettingsMenu(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  options: MenuOptions,
) {
  const value = (fast: boolean) => (fast ? "on" : "off");
  const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
    keybindings.getKeys(action).join("/") || "(unbound)";
  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let saving = false;
  let disposed = false;
  let saveController: AbortController | undefined;

  function dispose() {
    if (disposed) return;
    disposed = true;
    saveController?.abort();
  }

  const status = new Text("", 0, 0);
  const defaultValue = new Text("", 0, 0);
  function refreshDefault() {
    defaultValue.setText(
      theme.fg("dim", `Default: ${value(options.defaultFast)} · ${key("app.models.save")} save current as default`),
    );
  }
  refreshDefault();

  const settingsList = new SettingsList(
    [
      {
        id: "fast",
        label: "Fast",
        description: "Codex Priority mode. May increase usage costs.",
        currentValue: value(options.fast),
        values: ["off", "on"],
      },
    ],
    1,
    getSettingsListTheme(),
    (_id, selectedValue) => {
      try {
        options.onApply(selectedValue === "on");
        options.fast = selectedValue === "on";
        status.setText("");
      } catch (error) {
        // SettingsList updates the row before onChange; roll it back if applying fails.
        settingsList.updateValue("fast", value(options.fast));
        status.setText(theme.fg("error", `Application failed: ${errorMessage(error)}`));
      }
    },
    () => {
      dispose();
      options.onClose();
    },
  );

  async function save() {
    if (disposed || saving) return;
    saving = true;
    const controller = new AbortController();
    saveController = controller;
    status.setText(theme.fg("muted", "Saving…"));
    tui.requestRender();
    try {
      await options.onSave(options.fast, controller.signal);
      if (disposed) return;
      options.defaultFast = options.fast;
      refreshDefault();
      status.setText(theme.fg("muted", "Saved as default"));
    } catch (error) {
      if (disposed) return;
      const prefix = controller.signal.aborted ? "Save cancelled" : "Save failed";
      status.setText(theme.fg("error", `${prefix}: ${errorMessage(error)}`));
    } finally {
      saving = false;
      saveController = undefined;
      if (!disposed) tui.requestRender();
    }
  }

  const container = new Container();
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Codex Settings")), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(settingsList);
  container.addChild(defaultValue);
  container.addChild(status);
  container.addChild(new DynamicBorder((text) => theme.fg("border", text)));

  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    dispose,
    handleInput(data: string) {
      if (disposed) return;
      if (saving) {
        if (keybindings.matches(data, "tui.select.cancel")) saveController?.abort();
        return;
      }
      if (keybindings.matches(data, "app.models.save")) void save();
      else settingsList.handleInput(data);
      if (!disposed) tui.requestRender();
    },
    handleMouse(event: Parameters<SettingsList["handleMouse"]>[0]) {
      if (disposed || saving) return { handled: true };
      return container.handleMouse(event);
    },
  };
}
