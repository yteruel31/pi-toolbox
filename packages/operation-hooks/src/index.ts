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
export interface DeliveryContent { content: unknown; details?: unknown; isError?: boolean }
export interface DeliveryBlock { block: true; reason: string }
export interface OperationGate {
  assess(signal: AbortSignal): Promise<OperationBlock | void>;
  /** Runs before untrusted producer output is returned or stored. Never journal the body. */
  inspectDelivery?(delivery: DeliveryContent, signal: AbortSignal): Promise<DeliveryBlock | void>;
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
export interface OperationTicket {
  inspectDelivery<T>(value: T, signal?: AbortSignal): Promise<T>;
  result(isError: boolean): void;
}
const noop: OperationTicket = Object.freeze({ inspectDelivery: async <T>(value: T) => value, result() {} });
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
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function isGate(value: unknown): value is OperationGate {
  return !!value && typeof value === "object" && typeof (value as OperationGate).assess === "function" &&
    ((value as OperationGate).inspectDelivery === undefined || typeof (value as OperationGate).inspectDelivery === "function") &&
    ((value as OperationGate).result === undefined || typeof (value as OperationGate).result === "function");
}
function cloneDelivery<T>(value: T): { value: T; delivery: DeliveryContent } {
  let snapshot: T;
  try { snapshot = freeze(structuredClone(value)); }
  catch { throw new AuthorizationDenied("Operation result was withheld because it could not be inspected completely."); }
  // Inspect the complete immutable model-visible snapshot. Unsupported values,
  // accessors, cycles and binary/image bodies are classified as incomplete by the consumer.
  if (snapshot && typeof snapshot === "object" && "content" in snapshot) {
    const candidate = snapshot as Record<string, unknown>;
    const { content, details: existingDetails, isError, ...additionalFields } = candidate;
    const details = Object.keys(additionalFields).length ? { existingDetails, ...additionalFields } : existingDetails;
    return { value: snapshot, delivery: { content, details, ...(typeof isError === "boolean" ? { isError } : {}) } };
  }
  return { value: snapshot, delivery: { content: snapshot } };
}
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new AuthorizationDenied(message));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
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
  if (!bus) return Object.freeze({
    async inspectDelivery<T>(value: T, deliverySignal?: AbortSignal): Promise<T> {
      if (signal?.aborted || deliverySignal?.aborted) throw new AuthorizationDenied("Operation delivery cancelled.");
      return freeze(structuredClone(value));
    },
    result() {},
  });
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
        gates.push({ assess: gate.assess.bind(gate), inspectDelivery: gate.inspectDelivery?.bind(gate), result: gate.result?.bind(gate) });
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
  return {
    async inspectDelivery<T>(value: T, deliverySignal?: AbortSignal): Promise<T> {
      const controller = new AbortController();
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(deliverySignal ? [deliverySignal] : [])]);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const snapshot = cloneDelivery(value);
        for (const gate of gates) {
          if (!gate.inspectDelivery) continue;
          const verdict = await raceAbort(Promise.resolve().then(() => gate.inspectDelivery!(snapshot.delivery, combined)), combined, "Operation delivery cancelled or timed out.");
          if (verdict !== undefined) {
            if (!verdict || verdict.block !== true || typeof verdict.reason !== "string") throw new AuthorizationDenied();
            throw new AuthorizationDenied(verdict.reason);
          }
        }
        combined.throwIfAborted();
        return snapshot.value;
      } catch (error) {
        if (error instanceof AuthorizationDenied) throw error;
        throw new AuthorizationDenied(combined.aborted ? "Operation delivery cancelled or timed out." : "Operation result was withheld because delivery inspection failed.");
      } finally { clearTimeout(timer); controller.abort(); }
    },
    result(isError) {
      if (reported) return;
      reported = true;
      for (const gate of gates) {
        try { gate.result?.(isError); } catch { /* Execution already happened; observation can't undo it. */ }
      }
    },
  };
}
