import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const PROFILE_VERSION = 1;
export const MAX_NAME_LENGTH = 40;
export const MAX_SUMMARY_LENGTH = 1_200;
export const MAX_TRAITS = 8;
export const MAX_TRAIT_LENGTH = 160;

export interface VoiceProfile {
	version: 1;
	name: string;
	summary: string;
	traits: string[];
}

export function profilePath(agentDir = getAgentDir()): string {
	return join(agentDir, "unslop", "voice.json");
}

function cleanText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim();
	return cleaned && cleaned.length <= max ? cleaned : undefined;
}

export function validateProfile(value: unknown): VoiceProfile | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== PROFILE_VERSION) return undefined;
	const name = cleanText(candidate.name, MAX_NAME_LENGTH);
	const summary = cleanText(candidate.summary, MAX_SUMMARY_LENGTH);
	if (!name || !summary || !Array.isArray(candidate.traits) || candidate.traits.length > MAX_TRAITS) return undefined;
	const traits = candidate.traits.map((trait) => cleanText(trait, MAX_TRAIT_LENGTH));
	if (traits.some((trait) => !trait)) return undefined;
	return { version: 1, name, summary, traits: traits as string[] };
}

export async function loadProfile(agentDir = getAgentDir()): Promise<VoiceProfile | undefined> {
	try {
		return validateProfile(JSON.parse(await readFile(profilePath(agentDir), "utf8")));
	} catch {
		return undefined;
	}
}

export async function saveProfile(value: unknown, agentDir = getAgentDir()): Promise<VoiceProfile> {
	const profile = validateProfile(value);
	if (!profile) throw new Error("Invalid voice profile");
	const target = profilePath(agentDir);
	const directory = dirname(target);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const temporary = join(directory, `.voice-${process.pid}-${Date.now()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(profile, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, target);
		await chmod(target, 0o600);
		return profile;
	} finally {
		await rm(temporary, { force: true });
	}
}
