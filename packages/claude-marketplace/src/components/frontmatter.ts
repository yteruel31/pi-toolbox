export function frontmatterBlock(content: string): { bodyStart: number; data: string } | undefined {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	return match ? { bodyStart: match[0].length, data: match[1] } : undefined;
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function isFrontmatterKeyLine(line: string): boolean {
	return /^[A-Za-z0-9_-]+:\s*/.test(line);
}

export function stripYamlQuotes(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "");
}

export function normalizeBlockScalar(lines: string[], style: "|" | ">" = "|"): string {
	const nonBlankIndents = lines
		.filter((line) => line.trim())
		.map((line) => line.match(/^\s*/)?.[0].length ?? 0);
	const indent = nonBlankIndents.length ? Math.min(...nonBlankIndents) : 0;
	const normalized = lines.map((line) => line.slice(Math.min(indent, line.length))).join("\n").trim();
	return style === ">" ? normalized.replace(/\n+/g, " ").replace(/\s+/g, " ").trim() : normalized;
}

export function readFrontmatterField(content: string, field: string): string | undefined {
	const frontmatter = frontmatterBlock(content);
	if (!frontmatter) return undefined;
	const lines = frontmatter.data.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(new RegExp(`^${field}:\\s*(.*)$`));
		if (!match) continue;
		const rawValue = match[1].trim();
		const blockStyle = rawValue.match(/^([|>])/);
		if (!blockStyle) return stripYamlQuotes(rawValue);

		const blockLines: string[] = [];
		for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
			if (isFrontmatterKeyLine(lines[nextIndex])) break;
			blockLines.push(lines[nextIndex]);
		}
		return normalizeBlockScalar(blockLines, blockStyle[1] as "|" | ">");
	}
	return undefined;
}

export function removeFrontmatterFields(data: string, fields: string[]): string[] {
	const remove = new Set(fields);
	const lines = data.split(/\r?\n/);
	const kept: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const keyMatch = lines[index].match(/^([A-Za-z0-9_-]+):\s*/);
		if (!keyMatch || !remove.has(keyMatch[1])) {
			kept.push(lines[index]);
			continue;
		}

		for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
			if (isFrontmatterKeyLine(lines[nextIndex])) break;
			index = nextIndex;
		}
	}
	return kept;
}
