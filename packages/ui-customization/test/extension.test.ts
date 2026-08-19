import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import uiCustomizationExtension from "../src/index.js";
import { MCP_STATUS_CHANNEL } from "../src/events.js";

describe("ui customization extension", () => {
  it("installs and restores the footer across the session lifecycle", async () => {
    const lifecycle = new Map<string, (...args: unknown[]) => unknown>();
    const bus = new Map<string, (payload: unknown) => void>();
    const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
    const pi = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => lifecycle.set(event, handler),
      events: {
        on: (channel: string, handler: (payload: unknown) => void) => {
          bus.set(channel, handler);
          return () => bus.delete(channel);
        },
      },
      registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
        commands.set(name, command);
      },
    } as unknown as ExtensionAPI;

    uiCustomizationExtension(pi);
    bus.get(MCP_STATUS_CHANNEL)?.({
      v: 1,
      counts: { connected: 2, enabled: 2, authRequired: 0, errors: 0, disabled: 0 },
    });

    let footerFactory: ((...args: any[]) => any) | undefined;
    const setFooter = vi.fn((factory: typeof footerFactory) => { footerFactory = factory; });
    const ctx = {
      hasUI: true,
      ui: { setFooter, notify: vi.fn() },
      sessionManager: {
        getSessionName: () => "Footer test",
        getCwd: () => "/tmp/project",
        getEntries: () => [],
      },
      getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
      model: { id: "test-model", provider: "test", contextWindow: 1_000, reasoning: true },
      thinkingLevel: "medium",
    } as unknown as ExtensionContext;

    await lifecycle.get("session_start")?.({}, ctx);
    expect(setFooter).toHaveBeenCalledOnce();
    expect(footerFactory).toBeTypeOf("function");

    const unsubscribe = vi.fn();
    const component = footerFactory!(
      { requestRender: vi.fn() },
      { fg: (_color: string, text: string) => text } as Theme,
      {
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => unsubscribe,
      },
    );
    expect(component.render(120).join("\n")).toContain("MCPS");
    component.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();

    await commands.get("footer")?.handler("", ctx);
    expect(setFooter).toHaveBeenLastCalledWith(undefined);

    await lifecycle.get("session_shutdown")?.({}, ctx);
  });
});
