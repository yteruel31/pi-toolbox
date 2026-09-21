import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_BASE_URL, JEV_MAX_RESPONSE_BYTES, JEV_MODEL, JEV_TIMEOUT_MS, requestJevChoice, requestJevConnection, type JevFetch } from "../src/agents/jev-client.js";

const criteria = { low: "Low", high: "High" };
const validAnswer = (choice = "high", confidence = 0.01, probabilities: Record<string, number> = { low: 0.2, high: 0.8 }) => ({
  model: JEV_MODEL,
  answers: { route: { type: "choice", choice, confidence, probabilities } },
  usage: { input_tokens: 1, output_tokens: 1 },
});
const jsonResponse = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const call = (fetchImpl: JevFetch, signal?: AbortSignal) => requestJevChoice({ apiKey: "explicit-key", state: { task: "private-task" }, criteria, fetchImpl, signal });

const savedEnv = { ...process.env };
afterEach(() => {
  vi.useRealTimers();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
});

describe("Jev client transport boundaries", () => {
  it("times out a blocked transport exactly once without retry and observes a late rejection", async () => {
    vi.useFakeTimers();
    let rejectFetch!: (error: Error) => void;
    const fetcher = vi.fn(() => new Promise<Response>((_, reject) => { rejectFetch = reject; }));
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    try {
      const pending = call(fetcher);
      let settled = false; void pending.finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS - 1); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await expect(pending).rejects.toThrow("timed out after 5 seconds");
      expect(fetcher).toHaveBeenCalledTimes(1);
      rejectFetch(new Error("late-private-sentinel")); await Promise.resolve(); await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("does no fetch for pre-abort and sanitizes an in-flight abort reason", async () => {
    const pre = new AbortController(); pre.abort("pre-secret"); const never = vi.fn();
    await expect(call(never, pre.signal)).rejects.toThrow("cancelled"); expect(never).not.toHaveBeenCalled();
    let requestSignal!: AbortSignal;
    const fetcher = vi.fn((_url, init) => { requestSignal = init!.signal!; return new Promise<Response>(() => {}); });
    const controller = new AbortController(); const pending = call(fetcher, controller.signal); controller.abort("abort-secret-sentinel");
    const error = await pending.then(() => new Error("unexpected success"), (value: unknown) => value as Error); expect(error.message).toBe("Jev request was cancelled."); expect(error.message).not.toContain("sentinel");
    expect(requestSignal.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500])("does not retry status %s and sanitizes hostile bodies", async (status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn(async () => new Response("task-secret key-secret hostile-body", { status }));
    const error = await call(fetcher).then(() => new Error("unexpected success"), (value: unknown) => value as Error);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(error.message).toBe("Jev request failed."); expect(error.message).not.toMatch(/secret|hostile/); expect(log).not.toHaveBeenCalled();
  });

  it("sanitizes thrown transport errors without retry", async () => {
    const fetcher = vi.fn(async () => { throw new Error("transport-key-sentinel"); });
    const error = await call(fetcher).then(() => new Error("unexpected success"), (value: unknown) => value as Error);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(error.message).toBe("Jev request failed."); expect(error.message).not.toContain("sentinel");
  });

  it("uses fixed explicit SDK configuration and ignores hostile environment overrides", async () => {
    process.env.TYPESAFE_BASE_URL = "http://evil.invalid"; process.env.TYPESAFE_DEFAULT_MODEL = "evil-model"; process.env.TYPESAFE_LOG_LEVEL = "debug";
    const methods = ["debug", "info", "warn", "error"] as const; const logs = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`${JEV_BASE_URL}/v1/systemone`); expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-key");
      expect(JSON.parse(String(init?.body)).model).toBe(JEV_MODEL); return jsonResponse(validAnswer());
    });
    await call(fetcher); expect(fetcher).toHaveBeenCalledTimes(1); for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong answer type", { ...validAnswer(), answers: { route: { type: "score", choice: "high", confidence: 1, probabilities: { low: 0, high: 1 } } } }],
    ["choice outside criteria", validAnswer("missing")],
    ["missing probability", validAnswer("high", 1, { high: 1 })],
    ["extra probability", validAnswer("high", 1, { low: 0, high: 1, extra: 0 })],
    ["negative probability", validAnswer("high", 1, { low: -0.1, high: 1.1 })],
    ["probability above one", validAnswer("high", 1, { low: 0, high: 1.1 })],
    ["sum mismatch", validAnswer("high", 1, { low: 0.3, high: 0.8 })],
    ["choice not highest", validAnswer("low", 1, { low: 0.2, high: 0.8 })],
    ["missing confidence", { ...validAnswer(), answers: { route: { type: "choice", choice: "high", probabilities: { low: 0.2, high: 0.8 } } } }],
    ["negative confidence", validAnswer("high", -0.1)],
    ["confidence above one", validAnswer("high", 1.1)],
  ])("rejects malformed answer: %s", async (_name, body) => {
    await expect(call(async () => jsonResponse(body))).rejects.toThrow("Jev request failed.");
  });

  it("rejects non-finite numeric fields and accepts valid low confidence", async () => {
    const nan = validAnswer(); nan.answers.route.probabilities.low = Number.NaN;
    await expect(call(async () => jsonResponse(nan))).rejects.toThrow("Jev request failed.");
    await expect(call(async () => jsonResponse(validAnswer("high", 0)))).resolves.toMatchObject({ choice: "high", confidence: 0 });
  });

  it("applies the same validated boundary to synthetic connection tests", async () => {
    await expect(requestJevConnection({ apiKey: "key", fetchImpl: async () => jsonResponse(validAnswer("missing", 1, { missing: 1 })) })).rejects.toThrow("Jev request failed.");
    await expect(requestJevConnection({ apiKey: "key", fetchImpl: async () => jsonResponse({ model: JEV_MODEL, answers: { route: { type: "choice", choice: "ok", confidence: 0, probabilities: { ok: 1 } } }, usage: {} }) })).resolves.toBeUndefined();
  });

  it("rejects declared and streamed response overflow categorically with one fetch", async () => {
    const declared = vi.fn(async () => new Response("", { headers: { "content-length": String(JEV_MAX_RESPONSE_BYTES + 1) } }));
    await expect(call(declared)).rejects.toThrow("Jev request failed."); expect(declared).toHaveBeenCalledTimes(1);
    const streamed = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(JEV_MAX_RESPONSE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } })));
    await expect(call(streamed)).rejects.toThrow("Jev request failed."); expect(streamed).toHaveBeenCalledTimes(1);
  });
});
