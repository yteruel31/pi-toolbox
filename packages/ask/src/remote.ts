import { randomUUID } from "node:crypto";
import {
  ASK_EVENT_PREFIX,
  safeRecord,
  type AskForm,
  type AskResult,
  type AskSource,
} from "./contracts.ts";
import { applyRemoteAnswers, buildResult, cancelledResult, createAskState, type RemoteAnswerInput } from "./domain.ts";

export const REMOTE_EVENTS = {
  started: `${ASK_EVENT_PREFIX}:started`,
  completed: `${ASK_EVENT_PREFIX}:completed`,
  submit: `${ASK_EVENT_PREFIX}:submit`,
  submitResult: `${ASK_EVENT_PREFIX}:submit-result`,
} as const;

interface EventBus {
  on(name: string, listener: (event: unknown) => void): void | (() => void);
  emit(name: string, event: unknown): void;
}

export interface ActiveFlow {
  flowId: string;
  form: AskForm;
  source: AskSource;
  toolCallId?: string;
  finish(result: AskResult): void;
}

interface FlowRecord extends ActiveFlow {
  status: "active" | "settled" | "completed";
  acceptedResult?: AskResult;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export class RemoteAskRegistry {
  private flows = new Map<string, FlowRecord>();
  private readonly events: EventBus;
  private readonly unsubscribe: () => void;

  constructor(events: EventBus) {
    this.events = events;
    this.unsubscribe = events.on(REMOTE_EVENTS.submit, (event) => this.submit(event)) ?? (() => {});
  }

  dispose(): void {
    this.unsubscribe();
  }

  open(form: AskForm, source: AskSource, finish: (result: AskResult) => void, toolCallId?: string): ActiveFlow {
    const flow: FlowRecord = {
      flowId: randomUUID(),
      form,
      source,
      ...(toolCallId ? { toolCallId } : {}),
      finish,
      status: "active",
    };
    this.flows.set(flow.flowId, flow);
    this.events.emit(REMOTE_EVENTS.started, {
      version: 1,
      flowId: flow.flowId,
      ...(toolCallId ? { toolCallId } : {}),
      source,
      ...(form.title ? { title: form.title } : {}),
      questions: form.questions.map((question) => ({ ...question, options: question.options.map((option) => ({ ...option })) })),
      createdAt: Date.now(),
    });
    return flow;
  }

  complete(flowId: string, result?: AskResult): void {
    const flow = this.flows.get(flowId);
    if (!flow || flow.status === "completed") return;
    const finalResult = result ?? flow.acceptedResult;
    if (!finalResult) return;
    flow.status = "completed";
    this.flows.delete(flowId);
    this.events.emit(REMOTE_EVENTS.completed, {
      version: 1,
      flowId,
      ...(flow.toolCallId ? { toolCallId: flow.toolCallId } : {}),
      source: flow.source,
      result: finalResult,
      completedAt: Date.now(),
    });
  }

  private reject(requestId: string, flowId: string, error: "flow_not_found" | "invalid_request" | "invalid_answer", message: string): void {
    this.events.emit(REMOTE_EVENTS.submitResult, { version: 1, requestId, flowId, ok: false, error, message });
  }

  private accept(requestId: string, flow: FlowRecord, result: AskResult): void {
    // Deactivate before emitting or invoking arbitrary listeners: only the first valid
    // submission can settle a flow, even if listeners synchronously submit again.
    flow.status = "settled";
    flow.acceptedResult = result;
    this.events.emit(REMOTE_EVENTS.submitResult, { version: 1, requestId, flowId: flow.flowId, ok: true });
    try {
      flow.finish(result);
    } catch {
      // A throwing UI must not strand the bridge without its terminal event.
      this.complete(flow.flowId, result);
    }
  }

  private submit(raw: unknown): void {
    const request = object(raw);
    const requestId = typeof request?.requestId === "string" ? request.requestId : "";
    const flowId = typeof request?.flowId === "string" ? request.flowId : "";
    if (request?.version !== 1 || !requestId || !flowId) {
      this.reject(requestId, flowId, "invalid_request", "version, requestId, and flowId are required");
      return;
    }
    const flow = this.flows.get(flowId);
    if (!flow || flow.status !== "active") {
      this.reject(requestId, flowId, "flow_not_found", "No active ask flow has this flowId");
      return;
    }
    const response = object(request.response);
    if (response?.kind === "cancel") {
      this.accept(requestId, flow, cancelledResult(flow.form, "User cancelled ask_user remotely."));
      return;
    }
    if (response?.kind !== "answer") {
      this.reject(requestId, flowId, "invalid_request", "response.kind must be answer or cancel");
      return;
    }
    const answerObject = object(response.answers);
    if (!answerObject) {
      this.reject(requestId, flowId, "invalid_answer", "response.answers must be an object keyed by question id");
      return;
    }
    const typed = safeRecord<RemoteAnswerInput>();
    for (const [id, rawAnswer] of Object.entries(answerObject)) {
      const answer = object(rawAnswer);
      if (!answer) {
        this.reject(requestId, flowId, "invalid_answer", `answer for ${id} must be an object`);
        return;
      }
      if (answer.values !== undefined && (!Array.isArray(answer.values) || answer.values.some((value) => typeof value !== "string"))) {
        this.reject(requestId, flowId, "invalid_answer", `values for ${id} must be strings`);
        return;
      }
      if (answer.customText !== undefined && typeof answer.customText !== "string") {
        this.reject(requestId, flowId, "invalid_answer", `customText for ${id} must be a string`);
        return;
      }
      if (answer.note !== undefined && typeof answer.note !== "string") {
        this.reject(requestId, flowId, "invalid_answer", `note for ${id} must be a string`);
        return;
      }
      const optionNotes = object(answer.optionNotes);
      if (answer.optionNotes !== undefined && (!optionNotes || Object.values(optionNotes).some((note) => typeof note !== "string"))) {
        this.reject(requestId, flowId, "invalid_answer", `optionNotes for ${id} must contain strings`);
        return;
      }
      const safeOptionNotes = safeRecord<string>();
      for (const [value, note] of Object.entries(optionNotes ?? safeRecord<unknown>())) safeOptionNotes[value] = note as string;
      typed[id] = {
        ...(answer.values ? { values: [...answer.values] as string[] } : {}),
        ...(typeof answer.customText === "string" ? { customText: answer.customText } : {}),
        ...(typeof answer.note === "string" ? { note: answer.note } : {}),
        ...(optionNotes ? { optionNotes: safeOptionNotes } : {}),
      };
    }
    const state = createAskState(flow.form);
    const error = applyRemoteAnswers(state, typed);
    if (error) {
      this.reject(requestId, flowId, "invalid_answer", error);
      return;
    }
    const mode = response.mode === undefined ? "submit" : response.mode;
    if (mode !== "submit" && mode !== "elaborate") {
      this.reject(requestId, flowId, "invalid_request", "response.mode must be submit or elaborate");
      return;
    }
    this.accept(requestId, flow, buildResult(state, mode));
  }
}
