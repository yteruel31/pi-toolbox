import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as T;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return fallback;
		}
		throw error;
	}
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, filePath);
}
