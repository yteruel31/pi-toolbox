import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPrompt, buildTeachMessage } from "./prompt.js";
import { loadProfile, saveProfile, type VoiceProfile } from "./profile.js";
import { buildRefineInstruction, collectRefineExcerpts, formatRefinePreview } from "./refine.js";

const SAVE_TOOL = "unslop_save_voice";
const REFINE_TRIGGER = "Refine my existing Unslop voice profile from the approved private sample.";
type Operation = "teaching" | "refining";
type StatusState = "active" | Operation;

function publishStatus(ctx: ExtensionContext, state: StatusState, name?: string): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const label = theme.fg("accent", theme.bold("UNSLOP"));
	if (state !== "active") {
		ctx.ui.setStatus("unslop", `${label}  ${theme.fg("warning", `● ${state}`)}`);
		return;
	}
	ctx.ui.setStatus("unslop", `${label}  ${theme.fg("success", "● active")}  ${theme.fg("dim", `·  voice: ${name ?? "not taught"}`)}`);
}

export default function unslopExtension(pi: ExtensionAPI): void {
	let profile: VoiceProfile | undefined;
	let operation: Operation | undefined;
	let toolsBeforeOperation: string[] | undefined;
	let operationContext: ExtensionContext | undefined;
	let oneShotRefinePrompt: string | undefined;

	const finishOperation = (ctx: ExtensionContext): void => {
		if (toolsBeforeOperation) pi.setActiveTools(toolsBeforeOperation);
		toolsBeforeOperation = undefined;
		operation = undefined;
		operationContext = undefined;
		oneShotRefinePrompt = undefined;
		publishStatus(ctx, "active", profile?.name);
	};
	const startOperation = (kind: Operation, ctx: ExtensionContext): void => {
		operation = kind;
		operationContext = ctx;
		toolsBeforeOperation = pi.getActiveTools();
		pi.setActiveTools([...new Set([...toolsBeforeOperation, SAVE_TOOL])]);
		publishStatus(ctx, kind);
	};

	pi.registerTool({
		name: SAVE_TOOL,
		label: "Save Unslop Voice",
		description: "Save a derived Unslop voice profile. Available only during /unslop teach or /unslop refine.",
		parameters: Type.Object({
			version: Type.Literal(1), name: Type.String({ maxLength: 40 }), summary: Type.String({ maxLength: 1200 }),
			traits: Type.Array(Type.String({ maxLength: 160 }), { maxItems: 8 }),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!operation) {
				oneShotRefinePrompt = undefined;
				throw new Error("Voice saving is not active.");
			}
			if (operation === "refining") {
				const existing = profile;
				if (!existing) { finishOperation(ctx); throw new Error("The existing voice profile is no longer available."); }
				const candidate = { ...params, name: existing.name };
				const comparison = `Existing (${existing.name}):\n${existing.summary}\nTraits: ${existing.traits.join("; ") || "none"}\n\nCandidate (${candidate.name}):\n${candidate.summary}\nTraits: ${candidate.traits.join("; ") || "none"}`;
				let accepted = false;
				try { accepted = await ctx.ui.confirm("Replace Unslop voice profile?", comparison); }
				catch (error) { finishOperation(ctx); throw error; }
				if (!accepted) {
					finishOperation(ctx);
					ctx.ui.notify("Refinement declined; the existing voice profile was preserved.", "info");
					return { content: [{ type: "text", text: "Candidate declined; existing profile preserved." }], details: {}, terminate: true };
				}
				try {
					profile = await saveProfile(candidate);
					finishOperation(ctx);
					ctx.ui.notify(`Unslop voice refined: ${profile.name}`, "info");
					return { content: [{ type: "text", text: "Refined voice profile saved." }], details: {}, terminate: true };
				} catch (error) { finishOperation(ctx); throw new Error(`Could not save voice profile: ${error instanceof Error ? error.message : "unknown error"}`); }
			}
			try {
				profile = await saveProfile(params);
				finishOperation(ctx);
				ctx.ui.notify(`Unslop voice saved: ${profile.name}`, "info");
				return { content: [{ type: "text", text: "Voice profile saved." }], details: {}, terminate: true };
			} catch (error) { finishOperation(ctx); throw new Error(`Could not save voice profile: ${error instanceof Error ? error.message : "unknown error"}`); }
		},
	});

	pi.registerCommand("unslop", {
		description: "Teach or privately refine the global Unslop writing voice",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) return null;
			const options = [
				{ value: "teach", label: "teach", description: "Teach from writing samples" },
				{ value: "refine", label: "refine", description: "Refine from bounded recent sessions" },
			];
			const lower = prefix.toLowerCase();
			const matches = options.filter((item) => item.value.startsWith(lower) && item.value !== lower);
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "refine") {
				if (!ctx.hasUI || ctx.mode !== "tui") return;
				if (operation || !ctx.isIdle()) { ctx.ui.notify("Unslop is already active or Pi is busy.", "warning"); return; }
				if (!profile) { ctx.ui.notify("No voice profile exists. Run /unslop teach first.", "warning"); return; }
				try {
					const collected = await collectRefineExcerpts();
					if (!collected.excerpts.length) { ctx.ui.notify("No eligible recent writing was found. Use /unslop teach to provide samples.", "warning"); return; }
					const approved = await ctx.ui.confirm("Refine from these exact excerpts?", `${formatRefinePreview(collected.excerpts)}\n\nOnly these ${collected.excerpts.length} excerpts (${collected.characters} characters from at most ${collected.filesRead} session files) will be submitted. Cancel to submit nothing.`);
					if (!approved) { ctx.ui.notify("Refinement cancelled; nothing was submitted.", "info"); return; }
					oneShotRefinePrompt = buildRefineInstruction(profile, collected.excerpts);
					startOperation("refining", ctx);
					try { pi.sendUserMessage(REFINE_TRIGGER); }
					catch (error) { finishOperation(ctx); ctx.ui.notify(`Could not start refinement: ${error instanceof Error ? error.message : "unknown error"}`, "error"); }
				} catch (error) { oneShotRefinePrompt = undefined; ctx.ui.notify(`Could not collect writing samples: ${error instanceof Error ? error.message : "unknown error"}`, "error"); }
				return;
			}
			const match = /^teach(?:\s+(.+))?$/.exec(trimmed);
			if (!match) { if (ctx.hasUI) ctx.ui.notify("Usage: /unslop teach [voice name] | /unslop refine", "warning"); return; }
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			if (operation || !ctx.isIdle()) { ctx.ui.notify("Unslop teaching is already active or Pi is busy.", "warning"); return; }
			const requestedName = match[1]?.trim();
			const name = requestedName || await ctx.ui.input("Voice name", profile?.name ?? "My voice");
			if (!name?.trim()) return;
			const samples: string[] = [];
			for (let index = 1; index <= 5; index += 1) {
				const sample = await ctx.ui.editor(`Writing sample ${index}${index > 1 ? " (leave empty to finish)" : ""}`, "");
				if (!sample?.trim()) break;
				samples.push(sample.trim().slice(0, 12_000));
				if (index >= 2 && !(await ctx.ui.confirm("Add another sample?", "More varied samples can improve the profile."))) break;
			}
			if (!samples.length) { ctx.ui.notify("Teaching cancelled; no samples were provided.", "info"); return; }
			startOperation("teaching", ctx);
			try { pi.sendUserMessage(buildTeachMessage(name.trim().slice(0, 40), samples)); }
			catch (error) { finishOperation(ctx); ctx.ui.notify(`Could not start teaching: ${error instanceof Error ? error.message : "unknown error"}`, "error"); }
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		profile = await loadProfile();
		oneShotRefinePrompt = undefined;
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== SAVE_TOOL));
		publishStatus(ctx, "active", profile?.name);
	});
	pi.on("before_agent_start", async (event) => {
		const refine = oneShotRefinePrompt;
		oneShotRefinePrompt = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPrompt(profile)}${refine ? `\n\n${refine}` : ""}` };
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (operation) { const ended = operation; finishOperation(ctx); ctx.ui.notify(`Unslop ${ended === "teaching" ? "teaching" : "refinement"} ended without a saved profile.`, "warning"); }
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		oneShotRefinePrompt = undefined;
		if (operation && operationContext) finishOperation(operationContext);
		if (ctx.hasUI) ctx.ui.setStatus("unslop", undefined);
	});
}
