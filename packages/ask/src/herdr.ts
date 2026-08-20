import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HERDR_BLOCKED_EVENT = "herdr:blocked";

export class HerdrAttention {
  private readonly active = new Set<symbol>();
  private readonly events: ExtensionAPI["events"];

  constructor(events: ExtensionAPI["events"]) {
    this.events = events;
  }

  block(label: string): () => void {
    const token = Symbol(label);
    this.active.add(token);
    this.events.emit(HERDR_BLOCKED_EVENT, { active: true, label });

    return () => {
      if (!this.active.delete(token)) return;
      this.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    };
  }

  clear(): void {
    for (const token of this.active) {
      this.active.delete(token);
      this.events.emit(HERDR_BLOCKED_EVENT, { active: false });
    }
  }
}

export function herdrWaitingLabel(title: string | undefined): string {
  return title ? `Answer needed: ${title}` : "Answer needed";
}
