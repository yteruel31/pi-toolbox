import type { Writable } from "node:stream";

import type { JsonRpcMessage } from "./types.js";

const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export class MessageFramer {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: JsonRpcMessage[] = [];

    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("LSP header exceeds 8KB");
        break;
      }
      if (headerEnd > MAX_HEADER_BYTES) throw new Error("LSP header exceeds 8KB");

      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
        throw new Error("LSP message body exceeds 10MB");
      }
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        const parsed = JSON.parse(body) as unknown;
        if (typeof parsed === "object" && parsed !== null) messages.push(parsed as JsonRpcMessage);
      } catch {
        // A malformed payload is isolated by Content-Length, so later frames remain readable.
      }
    }

    return messages;
  }
}

export function encodeMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export async function writeMessage(stream: Writable, message: JsonRpcMessage): Promise<void> {
  const frame = encodeMessage(message);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      stream.off("error", onError);
      reject(error);
    };
    stream.once("error", onError);
    stream.write(frame, (error) => {
      stream.off("error", onError);
      if (error) reject(error);
      else resolve();
    });
  });
}
