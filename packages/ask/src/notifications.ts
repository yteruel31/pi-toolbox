import { spawn } from "node:child_process";
import type { AskForm } from "./contracts.ts";
import type { AskConfig, NotificationChannel } from "./config.ts";

export interface NotificationPayload {
  event: "question.waiting";
  title: string;
  message: string;
}

export function waitingNotification(form: AskForm): NotificationPayload {
  const first = form.questions[0];
  return {
    event: "question.waiting",
    title: "pi ask",
    message: `Question waiting: ${first?.label || first?.prompt || "user input"}`,
  };
}

function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

export function terminalSequence(channel: NotificationChannel, payload: NotificationPayload): string | undefined {
  if (channel === "bell") return "\u0007";
  const title = terminalSafeText(payload.title);
  const message = terminalSafeText(payload.message);
  if (channel === "osc9") return `\u001b]9;${message}\u0007`;
  if (channel === "osc777") return `\u001b]777;notify;${title};${message}\u0007`;
  return undefined;
}

export type OrcaStatus = "waiting" | "working" | "done";

// Orca currently accepts at most 160 UTF-16 code units for toolInput. Keep the
// complete preview within that bound so its own normalizer never has to split it.
export const ORCA_QUESTION_PREVIEW_MAX_LENGTH = 160;

function truncateUnicode(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const ellipsis = "…";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let result = "";
  for (const { segment } of segmenter.segment(value)) {
    if (result.length + segment.length + ellipsis.length > maxLength) break;
    result += segment;
  }
  return `${result}${ellipsis}`;
}

export function orcaQuestionPreview(form: AskForm): string {
  const prompt = terminalSafeText(form.questions[0]?.prompt || "User input")
    .replace(/\s+/gu, " ")
    .trim() || "User input";
  const countSuffix = form.questions.length > 1 ? ` (${form.questions.length} questions)` : "";
  return `${truncateUnicode(prompt, ORCA_QUESTION_PREVIEW_MAX_LENGTH - countSuffix.length)}${countSuffix}`;
}

export function isOrcaEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  // Orca stamps ORCA_PANE_KEY on every PTY it owns; its managed Pi hook uses
  // the same field as the required pane-attribution guard.
  return Boolean(env.ORCA_PANE_KEY?.trim());
}

export function orcaStatusSequence(state: OrcaStatus, form?: AskForm): string {
  // Non-waiting payloads intentionally omit tool fields: Orca replaces them on
  // every status event, so this also removes the completed ask's preview.
  const payload = state === "waiting"
    ? { state, agentType: "pi", toolName: "ask_user", ...(form ? { toolInput: orcaQuestionPreview(form) } : {}) }
    : { state, agentType: "pi" };
  return `\u001b]9999;${JSON.stringify(payload)}\u0007`;
}

export interface NotificationDependencies {
  write(text: string): void;
  command(command: string, env: NodeJS.ProcessEnv): Promise<void>;
}

export const NOTIFICATION_COMMAND_TIMEOUT_MS = 5_000;

const defaults: NotificationDependencies = {
  write: (text) => process.stderr.write(text),
  command: (command, env) => new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, { shell: true, env, stdio: "ignore", detached });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and cleanup.
      }
      finish();
    }, NOTIFICATION_COMMAND_TIMEOUT_MS);
    timeout.unref();
    child.once("error", finish);
    child.once("exit", finish);
  }),
};

export async function notifyWaiting(
  form: AskForm,
  config: Pick<AskConfig, "notifications">,
  dependencies: NotificationDependencies = defaults,
): Promise<void> {
  if (!config.notifications.enabled) return;
  const payload = waitingNotification(form);
  for (const channel of config.notifications.channels) {
    try {
      const sequence = terminalSequence(channel, payload);
      if (sequence !== undefined) dependencies.write(sequence);
      else if (typeof channel === "object" && channel.type === "command") {
        await dependencies.command(channel.command, {
          ...process.env,
          ASK_NOTIFY_EVENT: payload.event,
          ASK_NOTIFY_TITLE: payload.title,
          ASK_NOTIFY_MESSAGE: payload.message,
        });
      }
    } catch {
      // Notifications are deliberately best effort.
    }
  }
}

export class WaitingNotifications {
  private readonly waiting = new Map<symbol, AskForm>();
  private engaged = false;
  private disposed = false;
  private state?: OrcaStatus;

  private readonly dependencies: NotificationDependencies;
  private readonly env: NodeJS.ProcessEnv;

  constructor(dependencies: NotificationDependencies = defaults, env: NodeJS.ProcessEnv = process.env) {
    this.dependencies = dependencies;
    this.env = env;
  }

  private report(state: OrcaStatus, form?: AskForm): boolean {
    try {
      this.dependencies.write(orcaStatusSequence(state, form));
      this.state = state;
      return true;
    } catch {
      // Status reporting must not affect the ask result.
      return false;
    }
  }

  begin(form: AskForm, config: Pick<AskConfig, "notifications">): () => void {
    if (this.disposed || !config.notifications.enabled) return () => {};
    if (!isOrcaEnvironment(this.env)) {
      void notifyWaiting(form, config, this.dependencies);
      return () => {};
    }
    // Match Orca's native hook: inherited child processes do not own the pane.
    if (this.env.ORCA_PI_STATUS_OWNED && this.env.ORCA_PI_STATUS_OWNED !== String(process.pid)) return () => {};
    if (!this.report("waiting", form)) return () => {};
    this.engaged = true;
    const id = Symbol();
    this.waiting.set(id, form);
    return () => {
      if (this.disposed || !this.waiting.delete(id)) return;
      const remaining = [...this.waiting.values()].at(-1);
      this.report(remaining ? "waiting" : "working", remaining);
    };
  }

  agentStart(): void {
    // Orca retains OSC rows independently of its native HTTP hook. Once used,
    // keep later runs in sync too, rather than leaving a retained `done` row.
    if (this.engaged && !this.disposed && !this.waiting.size) this.report("working");
  }

  settle(ctx: { isIdle(): boolean }): void {
    // agent_end is not a completion boundary (retry/compaction/follow-ups).
    if (this.engaged && !this.disposed && !this.waiting.size && ctx.isIdle() && this.state !== "done") this.report("done");
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.engaged && this.state !== "done") this.report("done");
    this.disposed = true;
    this.waiting.clear();
  }
}
