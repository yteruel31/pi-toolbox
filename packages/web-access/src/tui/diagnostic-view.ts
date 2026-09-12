import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DiagnosticReport, RedditDiagnosticResult, RenderProbeResult } from "../diagnostics.js";
import { inspectRedditAccess, inspectWebAccess, testIsolatedRendering, testRedditAccess } from "../diagnostics.js";
import type { RedditDiagnostic } from "../reddit-service.js";

export interface DiagnosticViewOptions {
  theme: Theme;
  keybindings: KeybindingsManager;
  onRender: () => void;
  inspectWeb?: () => Promise<DiagnosticReport>;
  inspectReddit?: () => Promise<RedditDiagnosticResult>;
  testRender?: (signal: AbortSignal) => Promise<RenderProbeResult>;
  testReddit?: (signal: AbortSignal) => Promise<RedditDiagnosticResult>;
  now?: () => Date;
}

type Action = "refresh" | "render" | "reddit";
type Focus = "actions" | "browser" | "reddit" | "advanced";
type Busy = Action;
interface Explicit<T> { result: T; at: string }

const actions: Array<{ id: Action; label: string; key: string }> = [
  { id: "refresh", label: "Refresh", key: "r" },
  { id: "render", label: "Test render", key: "t" },
  { id: "reddit", label: "Test Reddit", key: "e" },
];
const focuses: Focus[] = ["actions", "browser", "reddit", "advanced"];
const safe = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
const stamp = (value?: string): string => value && Number.isFinite(Date.parse(value)) ? value : "time unavailable";
const compactStamp = (value?: string): string => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString().replace("T", " ").slice(0, 16) + "Z"
  : "time unavailable";

/** State and bounded rendering for the Diagnostic tab. Inspections are local-only. */
export class DiagnosticView {
  private readonly options: DiagnosticViewOptions;
  private report?: DiagnosticReport;
  private redditLocal?: RedditDiagnosticResult;
  private webError?: string;
  private redditError?: string;
  private observedAt?: string;
  private renderProof?: Explicit<RenderProbeResult>;
  private redditProof?: Explicit<RedditDiagnosticResult>;
  private busy?: Busy;
  private controller?: AbortController;
  private action = 0;
  private focus = 0;
  private expanded = { browser: true, reddit: true, advanced: false };
  private scroll = 0;
  private pageRows = 1;
  private lastBodyRows = 0;
  private revealFocus = false;
  private closed = false;

  constructor(options: DiagnosticViewOptions) {
    this.options = options;
    void this.refresh();
  }

  dispose(): void {
    this.closed = true;
    this.controller?.abort();
    this.controller = undefined;
  }

  private redraw(): void { if (!this.closed) this.options.onRender(); }
  private now(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }

  private async refresh(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = "refresh";
    this.webError = undefined;
    this.redditError = undefined;
    this.redraw();
    const [web, reddit] = await Promise.allSettled([
      (this.options.inspectWeb ?? inspectWebAccess)(),
      (this.options.inspectReddit ?? inspectRedditAccess)(),
    ]);
    if (!this.closed) {
      if (web.status === "fulfilled") this.report = web.value;
      else { this.report = undefined; this.webError = "Web browser inspection failed; local status is unknown."; }
      if (reddit.status === "fulfilled") this.redditLocal = reddit.value;
      else { this.redditLocal = undefined; this.redditError = "Reddit config inspection failed; Reddit status is unknown."; }
      this.observedAt = this.now();
      this.scroll = Math.min(this.scroll, Math.max(0, this.lastBodyRows - this.pageRows));
    }
    if (!this.closed) { this.busy = undefined; this.redraw(); }
  }

  private async run(action: "render" | "reddit"): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = action;
    const controller = new AbortController();
    this.controller = controller;
    this.redraw();
    try {
      if (action === "render") {
        let result: RenderProbeResult;
        try { result = await (this.options.testRender ?? testIsolatedRendering)(controller.signal); }
        catch { result = { state: "failed", summary: "Render test failed; cause unknown. No raw diagnostics are displayed." }; }
        if (!this.closed) {
          if (controller.signal.aborted && result.state === "passed") result = { state: "cancelled", summary: "Render test cancelled; cleanup finished." };
          this.renderProof = { result, at: this.now() };
        }
      } else {
        let result: RedditDiagnosticResult;
        try { result = await (this.options.testReddit ?? testRedditAccess)(controller.signal); }
        catch {
          result = { enabled: true, diagnostic: { status: "browser_unavailable", eligible: false, message: "Reddit validation failed; cause unknown. No raw diagnostics are displayed." } };
        }
        if (!this.closed) {
          if (controller.signal.aborted && result.diagnostic.status === "ready") result = { ...result, diagnostic: { status: "cancelled", eligible: false, message: "Reddit browser validation was cancelled; cached readiness is unchanged." } };
          this.redditProof = { result, at: this.now() };
          // The service result is also the newest local eligibility observation.
          if (result.diagnostic.status !== "cancelled") this.redditLocal = result;
        }
      }
    } finally {
      if (!this.closed) {
        this.controller = undefined;
        this.busy = undefined;
        this.redraw();
      }
    }
  }

  private activate(): void {
    const focused = focuses[this.focus]!;
    if (focused === "actions") {
      const action = actions[this.action]!.id;
      if (action === "refresh") void this.refresh(); else void this.run(action);
    } else {
      this.expanded[focused] = !this.expanded[focused];
      this.redraw();
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.busy) {
      if (data === "c" && this.controller) { this.controller.abort(); this.redraw(); }
      return;
    }
    if (data === "r") void this.refresh();
    else if (data === "t") void this.run("render");
    else if (data === "e") void this.run("reddit");
    else if (data === "a") { this.expanded.advanced = !this.expanded.advanced; this.focus = focuses.indexOf("advanced"); this.revealFocus = true; this.redraw(); }
    else if (data === "f") { this.focus = (this.focus + 1) % focuses.length; this.revealFocus = true; this.redraw(); }
    else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.focus = 0;
      this.action = (this.action + (matchesKey(data, "right") ? 1 : actions.length - 1)) % actions.length;
      this.redraw();
    } else if (this.options.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) this.activate();
    else if (matchesKey(data, "home")) { this.scroll = 0; this.redraw(); }
    else if (matchesKey(data, "end")) { this.scroll = Math.max(0, this.lastBodyRows - this.pageRows); this.redraw(); }
    else if (this.options.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down")) { this.scroll++; this.redraw(); }
    else if (this.options.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up")) { this.scroll = Math.max(0, this.scroll - 1); this.redraw(); }
    else if (matchesKey(data, "pageDown")) { this.scroll += this.pageRows; this.redraw(); }
    else if (matchesKey(data, "pageUp")) { this.scroll = Math.max(0, this.scroll - this.pageRows); this.redraw(); }
  }

  private heading(name: "browser" | "reddit" | "advanced", label: string): string {
    const selected = focuses[this.focus] === name;
    const marker = selected ? "▸" : this.expanded[name] ? "▾" : "▸";
    const text = `${marker} ${label}`;
    return selected ? this.options.theme.bg("selectedBg", this.options.theme.fg("accent", this.options.theme.bold(text))) : this.options.theme.bold(text);
  }

  private browserLines(): string[] {
    const t = this.options.theme;
    const proof = this.renderProof;
    let status: string;
    const unavailable = !proof && (this.webError || this.report?.checks.some((check) => check.state === "unavailable"));
    if (!proof) status = t.fg(unavailable ? "warning" : "muted", unavailable ? "! NOT TESTED" : "○ NOT TESTED")
      + (unavailable ? " — Local browser unavailable; see Advanced." : " — Run Test render (synthetic). ");
    else if (proof.result.state === "passed") status = t.fg("success", "✓ PASSED") + ` — Synthetic render · ${compactStamp(proof.at)}`;
    else if (proof.result.state === "cancelled") status = t.fg("warning", "! CANCELLED") + ` — No new proof · ${compactStamp(proof.at)}`;
    else status = t.fg("error", "✗ FAILED") + ` — Synthetic render · ${compactStamp(proof.at)}`;
    const lines = [this.heading("browser", "WEB BROWSER")];
    if (this.expanded.browser) {
      lines.push(`  ${status.trimEnd()}`);
      lines.push(`  ${t.fg("muted", "○ External sites: not tested")}`);
    }
    return lines;
  }

  private redditStatus(): { color: "success" | "warning" | "error" | "muted"; symbol: string; label: string; action: string; stale: boolean } {
    const local = this.redditLocal;
    const stale = this.redditProof?.result.diagnostic.status === "ready"
      && Boolean(this.redditError || (local && (!local.enabled || local.diagnostic.status !== "ready")));
    if (!local) return { color: "muted", symbol: "○", label: "UNKNOWN", action: "Refresh local config/profile status.", stale };
    if (!local.enabled) return { color: "warning", symbol: "!", label: "DISABLED", action: "Enable web access, then refresh.", stale };
    const status = local.diagnostic.status;
    if (status === "ready") return { color: "success", symbol: "✓", label: "READY", action: "Validated for current profile; run /reload if needed.", stale };
    if (status === "not_configured") return { color: "muted", symbol: "○", label: "NOT CONFIGURED", action: "Configure the Reddit profile, then refresh.", stale };
    if (status === "untested") return { color: "muted", symbol: "○", label: "NOT TESTED", action: "Run Test Reddit to validate this profile.", stale };
    if (status === "cancelled") return { color: "warning", symbol: "!", label: "CANCELLED", action: "Refresh to read current eligibility.", stale };
    const warning = status === "profile_busy" || status === "timeout";
    return { color: warning ? "warning" : "error", symbol: warning ? "!" : "✗", label: status.replaceAll("_", " ").toUpperCase(), action: "Fix the current condition, then test again.", stale };
  }

  private redditLines(): string[] {
    const t = this.options.theme;
    const state = this.redditStatus();
    const lines = [this.heading("reddit", "REDDIT")];
    if (this.expanded.reddit) {
      const stale = state.stale ? " · STALE VALIDATION" : "";
      lines.push(`  ${t.fg(state.color, `${state.symbol} ${state.label}${stale}`)} — ${state.action}`);
      if (this.redditProof?.result.diagnostic.status === "cancelled") lines.push(`  ${t.fg("warning", "! Latest test cancelled")} · ${compactStamp(this.redditProof.at)}`);
      const validatedAt = this.redditLocal?.diagnostic.lastValidatedAt;
      if (validatedAt) lines.push(`  Last validation: ${compactStamp(validatedAt)}`);
    }
    return lines;
  }

  private advancedLines(): string[] {
    const t = this.options.theme;
    const lines = [this.heading("advanced", "ADVANCED [a]")];
    if (!this.expanded.advanced) return lines;
    lines.push(`  ${t.fg("dim", `Latest local snapshot: ${stamp(this.observedAt)}. Local inspection only; observations are not test results.`)}`,
      `  ${t.fg("dim", "Reddit uses its configured native profile browser, distinct from the general bwrap renderer.")}`);
    if (this.webError) lines.push(`  ${t.fg("error", this.webError)}`);
    for (const check of this.report?.checks ?? []) {
      const color = check.state === "warning" || check.state === "unavailable" ? "warning" : check.state === "untested" ? "muted" : "text";
      lines.push(`  ${t.fg(color, `${check.label} [${check.state}]`)}: ${safe(check.summary)}`);
    }
    if (this.redditError) lines.push(`  ${t.fg("error", this.redditError)}`);
    if (this.renderProof) lines.push(`  Latest render detail (${stamp(this.renderProof.at)}): ${safe(this.renderProof.result.summary)}`);
    if (this.redditLocal) lines.push(`  Current Reddit detail: ${safe(this.redditLocal.diagnostic.message)}`);
    if (this.redditProof) lines.push(`  Latest Reddit action (${stamp(this.redditProof.at)}, ${this.redditProof.result.diagnostic.status}): ${safe(this.redditProof.result.diagnostic.message)}`);
    if (this.report?.remedies.length) lines.push(`  ${t.fg("warning", "Manual remedies — review; never executed by this panel:")}`, ...this.report.remedies.map((line) => `  ${safe(line)}`));
    return lines;
  }

  render(width: number, maxRows: number): string[] {
    width = Math.max(1, width);
    maxRows = Math.max(1, maxRows);
    const t = this.options.theme;
    const actionText = actions.map((item, index) => {
      const label = `[${item.label} ${item.key}]`;
      return this.focus === 0 && index === this.action ? t.bg("selectedBg", t.fg("accent", `▸${label}`)) : t.fg("muted", label);
    }).join(" ");
    const busy = this.busy ? (this.busy === "refresh" ? "Reading local metadata only…" : this.controller?.signal.aborted ? "Cancelling; waiting for browser cleanup…" : `${this.busy === "render" ? "Testing synthetic render" : "Testing Reddit"}… c cancels`) : undefined;
    const browserRows = this.browserLines().flatMap((line) => wrapTextWithAnsi(line, width));
    const redditRows = this.redditLines().flatMap((line) => wrapTextWithAnsi(line, width));
    const advancedRows = this.advancedLines().flatMap((line) => wrapTextWithAnsi(line, width));
    const sectionStarts = [0, 0, browserRows.length + 1, browserRows.length + 1 + redditRows.length + 1];
    const body = [...browserRows, "", ...redditRows, "", ...advancedRows];
    const actionRows = wrapTextWithAnsi(actionText, width);
    const busyRows = busy ? wrapTextWithAnsi(t.fg("warning", busy), width).slice(0, 2) : [];
    const footerRows = [
      t.fg("dim", "Tab/Shift+Tab · Esc close"),
      t.fg("dim", this.focus === 0 ? "←→ choose · Enter run · f sections · ↑↓/Pg scroll" : "Enter toggle · f next section · ↑↓/Pg scroll · a advanced"),
    ];
    this.pageRows = Math.max(1, maxRows - actionRows.length - busyRows.length - footerRows.length);
    if (body.length > this.pageRows) this.pageRows = Math.max(1, this.pageRows - 1); // reserve progress row
    this.lastBodyRows = body.length;
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - this.pageRows));
    if (this.revealFocus) {
      const target = sectionStarts[this.focus]!;
      if (this.focus === 0) this.scroll = 0;
      else if (target < this.scroll || target >= this.scroll + this.pageRows) this.scroll = Math.min(target, Math.max(0, body.length - this.pageRows));
      this.revealFocus = false;
    }
    const visible = body.slice(this.scroll, this.scroll + this.pageRows);
    const progress = body.length > this.pageRows ? t.fg("dim", ` ${this.scroll + 1}-${this.scroll + visible.length}/${body.length}`) : "";
    const output = [...actionRows, ...busyRows, ...visible, ...(progress ? [progress] : []), ...footerRows];
    return output.slice(0, maxRows).map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}
