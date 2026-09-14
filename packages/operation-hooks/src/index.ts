import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

/** Producers own operation semantics; consumers own policy, prompting and storage. */
export const OPERATION_AUTHORIZATION_CHANNEL = "pi-toolbox:operation-authorization:v1";
export interface Operation {
  package: "mcp" | "web-access";
  name: string;
  toolName?: string;
  server?: string;
  urls?: string[];
  args: Record<string, unknown>;
  rootToolCallId?: string;
}
export interface OperationBus { emit(channel: string, data: unknown): void }
export interface SubscriptionBus extends OperationBus { on(channel: string, listener: (data: unknown) => void): () => void }
export interface OperationBlock { block: true; reason: string; terminate?: boolean }
export interface OperationGate {
  assess(signal: AbortSignal): Promise<OperationBlock | void>;
  /** Observation only; never include result bodies or credentials. */
  result?(isError: boolean): void;
}
export interface OperationRequest {
  v: 1;
  id: string;
  operation: Operation;
  /** Opaque producer context. Trusted consumers may narrow it to ExtensionContext. */
  context: unknown;
  signal?: AbortSignal;
  /** Synchronous registration only. The event bus does not await listeners. */
  provide(gate: OperationGate): void;
}
export interface OperationTicket { result(isError: boolean): void }
const noop: OperationTicket = Object.freeze({ result() {} });
const failure = "Operation authorization failed. No permission was granted.";
function safeReason(reason: string): string {
  return stripVTControlCharacters(reason).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 2000);
}
export class AuthorizationDenied extends Error {
  readonly block = true;
  readonly terminate: boolean;
  constructor(reason = failure, terminate = false) { super(safeReason(reason)); this.name = "AuthorizationDenied"; this.terminate = terminate; }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function isGate(value: unknown): value is OperationGate {
  return !!value && typeof value === "object" && typeof (value as OperationGate).assess === "function" &&
    ((value as OperationGate).result === undefined || typeof (value as OperationGate).result === "function");
}

/** Register at factory time; return a refusing gate when the consumer isn't ready. */
export function registerOperationProvider(bus: SubscriptionBus, factory: (request: OperationRequest) => OperationGate): () => void {
  return bus.on(OPERATION_AUTHORIZATION_CHANNEL, (data) => {
    const request = data as OperationRequest | undefined;
    if (request?.v !== 1 || typeof request.provide !== "function") return;
    // Pi's event bus swallows listener exceptions. Convert them to a registered veto.
    try { request.provide(factory(request)); }
    catch { request.provide({ assess: async () => ({ block: true, reason: failure }) }); }
  });
}

/** Await this immediately before the described operation. An emitted notice alone cannot authorize it. */
export async function authorizeOperation(
  bus: OperationBus | undefined, operation: Operation, context: unknown, signal?: AbortSignal,
  options: { timeoutMs?: number } = {},
): Promise<OperationTicket> {
  if (signal?.aborted) throw new AuthorizationDenied("Operation cancelled before authorization.");
  if (!bus) return noop;
  const gates: OperationGate[] = [];
  let accepting = true;
  let invalid = false;
  try {
    const request: OperationRequest = Object.freeze({
      v: 1, id: randomUUID(), operation: freeze(structuredClone(operation)), context, signal,
      provide(gate: OperationGate) {
        if (!accepting) return;
        if (!isGate(gate)) { invalid = true; return; }
        // Capture callbacks so later registration mutations cannot replace an evaluator.
        gates.push({ assess: gate.assess.bind(gate), result: gate.result?.bind(gate) });
      },
    });
    bus.emit(OPERATION_AUTHORIZATION_CHANNEL, request);
  } catch { invalid = true; }
  finally { accepting = false; }
  if (invalid) throw new AuthorizationDenied();
  if (!gates.length) return noop;
  const timeoutMs = options.timeoutMs ?? 360000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 360000) throw new AuthorizationDenied();
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new AuthorizationDenied("Operation authorization cancelled or timed out."));
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
      }),
      (async () => {
        for (const gate of gates) {
          if (combined.aborted) throw new AuthorizationDenied("Operation authorization cancelled.");
          const verdict = await gate.assess(combined);
          if (verdict !== undefined) {
            if (!verdict || verdict.block !== true || typeof verdict.reason !== "string" ||
                (verdict.terminate !== undefined && typeof verdict.terminate !== "boolean")) throw new AuthorizationDenied();
            throw new AuthorizationDenied(verdict.reason, verdict.terminate);
          }
        }
      })(),
    ]);
    if (combined.aborted) throw new AuthorizationDenied("Operation authorization cancelled.");
  } catch (error) {
    if (error instanceof AuthorizationDenied) throw error;
    throw new AuthorizationDenied();
  } finally {
    clearTimeout(timer);
    if (abort) combined.removeEventListener("abort", abort);
    controller.abort();
  }
  let reported = false;
  return { result(isError) {
    if (reported) return;
    reported = true;
    for (const gate of gates) {
      try { gate.result?.(isError); } catch { /* Execution already happened; observation can't undo it. */ }
    }
  } };
}
