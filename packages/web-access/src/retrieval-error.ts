export type RetrievalErrorCode = "invalid-id" | "cache-unavailable" | "cache-expired" | "invalid-selector" | "conflicting-selectors" | "invalid-pagination" | "find-with-offset" | "invalid-find" | "retrieval-budget";

const messages: Record<RetrievalErrorCode, string> = {
  "invalid-id": "Invalid content or research ID",
  "cache-unavailable": "Content is missing, expired, evicted or unreadable; fetch it again",
  "cache-expired": "Content has expired; fetch it again",
  "invalid-selector": "Document selector not found",
  "conflicting-selectors": "Choose one document selector",
  "invalid-pagination": "Invalid offset or limit (maximum 30000)",
  "find-with-offset": "findText cannot be combined with offset",
  "invalid-find": "findText requires 1 to 10 strings, each 1 to 500 characters",
  "retrieval-budget": "Content metadata exceeds the retrieval output budget; select a smaller source or fetch the selected URL separately.",
};

export function isRetrievalErrorCode(code: unknown): code is RetrievalErrorCode {
  return typeof code === "string" && Object.hasOwn(messages, code);
}

/** A fixed, safe error that may be shown after a local-only retrieval operation. */
export class RetrievalError extends Error {
  constructor(readonly code: RetrievalErrorCode) {
    super(isRetrievalErrorCode(code) ? messages[code] : "Web access operation failed.");
    this.name = "RetrievalError";
  }
}
