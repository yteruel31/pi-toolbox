import { AsyncLocalStorage } from "node:async_hooks";
import { authorizeOperation, type Operation, type OperationBus } from "@yteruel31/pi-operation-hooks";

export interface AuthorizationScope { bus?: OperationBus; context: unknown; rootToolCallId: string; toolName: string }
const scopes = new AsyncLocalStorage<AuthorizationScope>();
export const authorizationScope = () => scopes.getStore();
export function inAuthorizationScope<T>(scope: AuthorizationScope, action: () => T): T { return scopes.run(scope, action); }

/** Metadata is deliberately constructed before credential resolution. Never pass transport options. */
export async function authorized<T>(name: string, args: Record<string, unknown>, urls: string[] | undefined, signal: AbortSignal | undefined, action: () => Promise<T>, isError: (value: T) => boolean = () => false): Promise<T> {
  signal?.throwIfAborted();
  const scope = scopes.getStore();
  // Producer optionals are absent, not JSON values. Do not stringify or recursively
  // normalize unknown values: the operation bridge must still validate them.
  args = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  const operation: Operation = { package: "web-access", name, args: name === "fetch_content" ? { sideEffects: ["local-read", "cache-write", "optional-git-clone", "optional-media-process", "optional-browser"], ...args } : args, urls, toolName: scope?.toolName, rootToolCallId: scope?.rootToolCallId };
  const receipt = await authorizeOperation(scope?.bus, operation, scope?.context, signal);
  let failed = true;
  try { signal?.throwIfAborted(); const value = await action(); failed = isError(value); return value; }
  finally { receipt.result(failed); }
}

export const providerUrls: Record<string, string> = {
  brave: "https://api.search.brave.com/", gemini: "https://generativelanguage.googleapis.com/", openai: "https://api.openai.com/",
};

/** The first URL is covered by the containing fetch approval; new destinations are distinct actions. */
export function pageRequestAuthorization(initialUrls: string[]) {
  const scope = scopes.getStore();
  const initial = new Set(initialUrls.map((url) => { try { const parsed = new URL(url); parsed.hash = ""; return parsed.href; } catch { return url; } }));
  return async <T>(url: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> => {
    if (!scope || initial.has(url)) return action();
    return inAuthorizationScope(scope, () => authorized("fetch_content.request", { url, destinationKind: "page", internal: true }, [url], signal, action));
  };
}
