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
  const fetchImpl: JevFetch = async (url, init) => {
    const response = await transport(url, { ...init, redirect: "error" });
    return boundedResponse(response, controller.signal);
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
  } catch {
    if (options.signal?.aborted) throw new Error("Jev request was cancelled.");
    if (timedOut) throw new Error("Jev request timed out after 5 seconds.");
    throw new Error("Jev request failed.");
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
    throw new Error("response too large");
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
      if (size > JEV_MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("response too large"); }
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
  if (!isRecord(value) || !isRecord(value.answers) || !isRecord(value.answers.route)) throw new Error("invalid response");
  const answer = value.answers.route;
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !finiteFraction(answer.confidence) || !isRecord(answer.probabilities)) throw new Error("invalid response");
  const expected = Object.keys(criteria).sort();
  const actual = Object.keys(answer.probabilities).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) throw new Error("invalid response");
  if (!expected.includes(answer.choice)) throw new Error("invalid response");
  const probabilities: Record<string, number> = {};
  let total = 0;
  for (const key of expected) {
    const probability = answer.probabilities[key];
    if (!finiteFraction(probability)) throw new Error("invalid response");
    probabilities[key] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.001) throw new Error("invalid response");
  const highest = Math.max(...Object.values(probabilities));
  if (probabilities[answer.choice] !== highest) throw new Error("invalid response");
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

function finiteFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
