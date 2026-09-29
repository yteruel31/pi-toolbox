import { choice, TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";

export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 5_000;
export const JEV_MAX_RESPONSE_BYTES = 256 * 1024;

const ROUTE_INSTRUCTIONS = "Choose the available route that best balances capability and thinking effort for this task. Match task difficulty; don't maximize quality by default and don't optimize only for cost. Respect every explicit compatibility constraint encoded in the choices.";
const CONNECTION_CRITERIA = { ok: "Connection test option" } as const;

export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type JevFetch = Fetch;

/** Closed vocabulary: never retain SDK messages or response content. */
type JevFailureCode = "transport" | "http" | "sdk-response" | "response-size" | "answer-shape" | "probability-keys" | "unknown-choice" | "probability-value" | "probability-sum" | "choice-not-highest" | "timeout" | "cancelled";
export class JevRequestError extends Error {
  constructor(readonly code: JevFailureCode, readonly httpStatus?: number, message = "Jev request failed.") {
    super(message);
    this.name = "JevRequestError";
  }
}

export function jevFailureDiagnostic(error: unknown): string {
  if (!(error instanceof JevRequestError)) return "code=preparation; diagnostic=v1";
  return `code=${error.code}${error.httpStatus === undefined ? "" : `; http=${error.httpStatus}`}; diagnostic=v1`;
}

export async function requestJevChoice(options: {
  apiKey: string;
  state: unknown;
  criteria: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: JevFetch;
}): Promise<JevChoiceAnswer> {
  return request(options, ROUTE_INSTRUCTIONS);
}

export async function requestJevConnection(options: {
  apiKey: string;
  signal?: AbortSignal;
  fetchImpl?: JevFetch;
}): Promise<void> {
  await request({ ...options, state: { task: "Connection test" }, criteria: CONNECTION_CRITERIA }, "Return the only option.");
}

async function request(options: {
  apiKey: string;
  state: unknown;
  criteria: Record<string, string>;
  signal?: AbortSignal;
  fetchImpl?: JevFetch;
}, instructions: string): Promise<JevChoiceAnswer> {
  if (options.signal?.aborted) throw new Error("Jev request was cancelled.");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, JEV_TIMEOUT_MS);
  const transport = options.fetchImpl ?? fetch;
  let transportFailure: JevRequestError | undefined;
  let httpStatus: number | undefined;
  const fetchImpl: JevFetch = async (url, init) => {
    try {
      const response = await transport(url, { ...init, redirect: "error" });
      httpStatus = response.status;
      return await boundedResponse(response, controller.signal);
    } catch (error) {
      transportFailure = error instanceof JevRequestError ? error : new JevRequestError("transport");
      throw transportFailure;
    }
  };
  let stopAbortRace = () => {};
  try {
    const client = new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: JEV_BASE_URL,
      defaultModel: JEV_MODEL,
      timeout: JEV_TIMEOUT_MS,
      retry: { maxRetries: 0 },
      logLevel: "off",
      fetch: fetchImpl,
    });
    const sdkPromise = client.systemOne({
      state: options.state as never,
      model: JEV_MODEL,
      questions: { route: choice(instructions, options.criteria) },
    }, { signal: controller.signal, timeout: JEV_TIMEOUT_MS, retry: { maxRetries: 0 } });
    // A custom transport may ignore abort. Race it and still observe its eventual rejection.
    sdkPromise.catch(() => undefined);
    const abortRace = abortPromise(controller.signal);
    stopAbortRace = abortRace.cleanup;
    const result = await Promise.race([
      sdkPromise,
      abortRace.promise,
    ]);
    return validateChoice(result, options.criteria);
  } catch (error) {
    if (options.signal?.aborted) throw new JevRequestError("cancelled", httpStatus, "Jev request was cancelled.");
    if (timedOut) throw new JevRequestError("timeout", httpStatus, "Jev request timed out after 5 seconds.");
    const code = transportFailure?.code ?? (httpStatus !== undefined && httpStatus >= 400 ? "http" : error instanceof JevRequestError ? error.code : "sdk-response");
    throw new JevRequestError(code, httpStatus);
  } finally {
    clearTimeout(timer);
    stopAbortRace();
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

function abortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
  let abort = () => {};
  const promise = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Jev request stopped."));
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
  return { promise, cleanup: () => signal.removeEventListener("abort", abort) };
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (/^\d+$/.test(declared) ? Number(declared) : Infinity) > JEV_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new JevRequestError("response-size");
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > JEV_MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new JevRequestError("response-size"); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function validateChoice(value: unknown, criteria: Record<string, string>): JevChoiceAnswer {
  if (!isRecord(value) || !isRecord(value.answers) || !isRecord(value.answers.route)) throw new JevRequestError("answer-shape");
  const answer = value.answers.route;
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !finiteFraction(answer.confidence) || !isRecord(answer.probabilities)) throw new JevRequestError("answer-shape");
  const expected = Object.keys(criteria).sort();
  const actual = Object.keys(answer.probabilities).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) throw new JevRequestError("probability-keys");
  if (!expected.includes(answer.choice)) throw new JevRequestError("unknown-choice");
  const probabilities: Record<string, number> = {};
  let total = 0;
  for (const key of expected) {
    const probability = answer.probabilities[key];
    if (!finiteFraction(probability)) throw new JevRequestError("probability-value");
    probabilities[key] = probability;
    total += probability;
  }
  // The service rounds each probability to two decimals, so the sum can drift
  // by up to half a unit per choice (0.99 or 1.01 is routine with ~10 routes).
  if (Math.abs(total - 1) > 0.005 * expected.length + 1e-9) throw new JevRequestError("probability-sum");
  const highest = Math.max(...Object.values(probabilities));
  if (probabilities[answer.choice] !== highest) throw new JevRequestError("choice-not-highest");
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

function finiteFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
