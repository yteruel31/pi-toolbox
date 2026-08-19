import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPrompt, buildTeachMessage } from "./prompt.js";
import { loadProfile, saveProfile, type VoiceProfile } from "./profile.js";

const SAVE_TOOL = "unslop_save_voice";

type StatusState = "active" | "teaching";

function publishStatus(ctx: ExtensionContext, state: StatusState, name?: string): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	const label = theme.fg("accent", theme.bold("UNSLOP"));
	if (state === "teaching") {
		ctx.ui.setStatus("unslop", `${label}  ${theme.fg("warning", "● teaching")}`);
		return;
	}
	ctx.ui.setStatus("unslop", `${label}  ${theme.fg("success", "● active")}  ${theme.fg("dim", `·  voice: ${name ?? "not taught"}`)}`);
}

export default function unslopExtension(pi: ExtensionAPI): void {
	let profile: VoiceProfile | undefined;
	let teaching = false;
	let toolsBeforeTeach: string[] | undefined;
	let teachingContext: ExtensionContext | undefined;

	const finishTeaching = (ctx: ExtensionContext): void => {
		if (toolsBeforeTeach) pi.setActiveTools(toolsBeforeTeach);
		toolsBeforeTeach = undefined;
		teaching = false;
		teachingContext = undefined;
		publishStatus(ctx, "active", profile?.name);
	};

	pi.registerTool({
		name: SAVE_TOOL,
		label: "Save Unslop Voice",
		description: "Save the derived Unslop voice profile. Available only during /unslop teach.",
		parameters: Type.Object({
			version: Type.Literal(1),
			name: Type.String({ maxLength: 40 }),
			summary: Type.String({ maxLength: 1200 }),
			traits: Type.Array(Type.String({ maxLength: 160 }), { maxItems: 8 }),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!teaching) {
				finishTeaching(ctx);
				throw new Error("Voice saving is not active.");
			}
			try {
				profile = await saveProfile(params);
				finishTeaching(ctx);
				ctx.ui.notify(`Unslop voice saved: ${profile.name}`, "info");
				return { content: [{ type: "text", text: "Voice profile saved." }], details: {}, terminate: true };
			} catch (error) {
				finishTeaching(ctx);
				throw new Error(`Could not save voice profile: ${error instanceof Error ? error.message : "unknown error"}`);
			}
		},
	});

	pi.registerCommand("unslop", {
		description: "Teach Unslop your writing voice: /unslop teach [name]",
		handler: async (args, ctx) => {
			const match = /^teach(?:\s+(.+))?$/.exec(args.trim());
			if (!match) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /unslop teach [voice name]", "warning");
				return;
			}
			if (!ctx.hasUI || ctx.mode !== "tui") return;
			if (teaching || !ctx.isIdle()) {
				ctx.ui.notify("Unslop teaching is already active or Pi is busy.", "warning");
				return;
			}
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
			if (samples.length === 0) {
				ctx.ui.notify("Teaching cancelled; no samples were provided.", "info");
				return;
			}
			teaching = true;
			teachingContext = ctx;
			toolsBeforeTeach = pi.getActiveTools();
			pi.setActiveTools([...new Set([...toolsBeforeTeach, SAVE_TOOL])]);
			publishStatus(ctx, "teaching");
			try {
				pi.sendUserMessage(buildTeachMessage(name.trim().slice(0, 40), samples));
			} catch (error) {
				finishTeaching(ctx);
				ctx.ui.notify(`Could not start teaching: ${error instanceof Error ? error.message : "unknown error"}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		profile = await loadProfile();
		const active = pi.getActiveTools().filter((name) => name !== SAVE_TOOL);
		pi.setActiveTools(active);
		publishStatus(ctx, "active", profile?.name);
	});

	pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${buildPrompt(profile)}` }));

	pi.on("agent_settled", async (_event, ctx) => {
		if (teaching) {
			finishTeaching(ctx);
			ctx.ui.notify("Unslop teaching ended without a saved profile.", "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (teaching && teachingContext) finishTeaching(teachingContext);
		if (ctx.hasUI) ctx.ui.setStatus("unslop", undefined);
	});
}
