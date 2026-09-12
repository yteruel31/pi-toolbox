import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSetupSnapshot, saveSetup, setupErrorMessage } from "./setup-store.js";
import { SETUP_OVERLAY, SetupPanel, setupRows } from "./tui/setup-panel.js";

export function registerSetupCommand(pi: ExtensionAPI): void {
  pi.registerCommand("web-access", {
    description: "Set up web providers, models and private API key storage",
    getArgumentCompletions: (prefix) => ["setup", "config"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      // Never echo arguments: someone could accidentally put a key after the command.
      if (!["", "setup", "config"].includes(args.trim())) {
        ctx.ui.notify("Use /web-access setup or /web-access config. Enter API keys only in the masked setup field, never as command arguments.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Web access setup requires Pi's interactive terminal UI. Open Pi and run /web-access setup. Never send API keys through chat or RPC.", "warning");
        return;
      }
      try {
        const snapshot = await readSetupSnapshot();
        const saved = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => new SetupPanel({
          theme, keybindings, snapshot,
          maxRows: () => setupRows(tui.terminal.rows),
          onRender: () => tui.requestRender(),
          onDone: done,
          onSave: (draft, key) => saveSetup(snapshot, draft, key),
        }), { overlay: true, overlayOptions: SETUP_OVERLAY });
        if (saved) ctx.ui.notify("Web access saved. Run /reload to apply settings. No API request was made; credentials were not tested.", "info");
      } catch (error) { ctx.ui.notify(setupErrorMessage(error), "error"); }
    },
  });
}
