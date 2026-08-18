/**
 * Typed errors thrown by the core. Messages are size-bounded so they can be
 * reflected into model-visible tool output safely.
 */

import { truncateText } from "./truncate.js";

const MAX_ERROR_MESSAGE_CHARS = 500;

export class SubagentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(truncateText(message, MAX_ERROR_MESSAGE_CHARS));
    this.name = new.target.name;
    this.code = code;
  }
}

/** Spawn rejected because the global active-run cap is reached. */
export class ConcurrencyLimitError extends SubagentError {
  constructor(limit: number) {
    super(
      "concurrency_limit",
      `Too many active subagent runs: the global limit is ${limit} across all harnesses and /btw. Wait for or cancel an active run, then retry.`,
    );
  }
}

/** A referenced run id does not exist in this session. */
export class UnknownRunError extends SubagentError {
  constructor(id: string) {
    super("unknown_run", `Unknown subagent run id: ${JSON.stringify(id)}`);
  }
}

/** Caller passed structurally invalid input (empty prompt, empty ids, ...). */
export class InvalidArgumentError extends SubagentError {
  constructor(message: string) {
    super("invalid_argument", message);
  }
}

/** A wait call was aborted before every referenced run settled. */
export class WaitAbortedError extends SubagentError {
  constructor() {
    super(
      "wait_aborted",
      "subagent_wait was aborted before all referenced runs settled; no results were consumed.",
    );
  }
}

/** Extract a bounded, human-readable message from an arbitrary thrown value. */
export function describeError(err: unknown, maxChars = MAX_ERROR_MESSAGE_CHARS): string {
  if (err instanceof Error) {
    const message = err.message.trim() === "" ? err.name : err.message;
    return truncateText(message, maxChars);
  }
  return truncateText(String(err), maxChars);
}
