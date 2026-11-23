import { constants } from "node:fs";
import { appendFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import { atomicWriteIfBaseline, frontmatterParts } from "./store.ts";
import type { MemoryProvenance, ReadBaseline } from "./types.ts";

function provenanceRecord(provenance: MemoryProvenance, at: string) {
	return {
		role: provenance.role,
		at,
		session: provenance.sessionId,
		...(provenance.model ? { model: provenance.model } : {}),
	};
}

export function mergeMemoryProvenance(
	content: string,
	provenance: MemoryProvenance,
	at = new Date().toISOString(),
): string {
	const parts = frontmatterParts(content);
	const document = YAML.parseDocument(parts?.header ?? "");
	if (document.errors.length || (document.contents !== null && !YAML.isMap(document.contents)))
		throw new Error("Memory frontmatter must be a valid YAML mapping");
	document.set("provenance", provenanceRecord(provenance, at));
	const newline = parts?.newline ?? "\n";
	const header = document.toString().replace(/\r?\n/g, newline);
	// Never round-trip the body through YAML or trim its whitespace.
	return `${parts?.bom ?? ""}---${newline}${header}---${newline}${parts?.body ?? content}`;
}

export const PROVENANCE_LOG_MAX_BYTES = 5 * 1024 * 1024;

export async function appendProvenance(
	locksDir: string,
	provenance: MemoryProvenance,
	entry: {
		at: string;
		path: string;
		action: "create" | "update" | "delete";
		baseline: string | null;
		result: string | null;
	},
): Promise<void> {
	try {
		const log = join(locksDir, "..", "provenance.jsonl");
		const line = `${JSON.stringify({ ...provenanceRecord(provenance, entry.at), ...entry })}\n`;
		await withFileMutationQueue(log, async () => {
			await mkdir(dirname(log), { recursive: true, mode: 0o700 });
			const info = await lstat(log).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Unsafe provenance log");
			if (info && info.size + Buffer.byteLength(line) > PROVENANCE_LOG_MAX_BYTES) {
				await rm(`${log}.1`, { force: true });
				await rename(log, `${log}.1`);
			}
			await appendFile(log, line, {
				mode: 0o600,
				flag:
					constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_APPEND |
					(process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
			});
		});
	} catch {
		// The audit trail is bounded, best-effort private state, never a write gate.
	}
}

export async function writeMemoryWithProvenance(
	filePath: string,
	expected: ReadBaseline | null,
	content: string,
	context: { locksDir: string; path: string; provenance?: MemoryProvenance; baseline?: string | null },
	guard?: () => void | Promise<void>,
): Promise<ReadBaseline & { content: string }> {
	const at = new Date().toISOString();
	const stamped = context.provenance ? mergeMemoryProvenance(content, context.provenance, at) : content;
	const written = await atomicWriteIfBaseline(filePath, expected, () => stamped, undefined, guard, {
		onCommitted: async (before, after) => {
			if (!context.provenance) return;
			const hash = context.baseline === undefined ? (before?.hash ?? null) : context.baseline;
			await appendProvenance(context.locksDir, context.provenance, {
				at,
				path: context.path,
				action: hash === null ? "create" : "update",
				baseline: hash,
				result: after.hash,
			});
		},
	});
	return { ...written, content: stamped };
}
