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

export function terminalSequence(channel: NotificationChannel, payload: NotificationPayload): string | undefined {
  if (channel === "bell") return "\u0007";
  if (channel === "osc9") return `\u001b]9;${payload.message}\u0007`;
  if (channel === "osc777") return `\u001b]777;notify;${payload.title};${payload.message}\u0007`;
  return undefined;
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
