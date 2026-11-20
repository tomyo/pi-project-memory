import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { containsVcsMetadataSegment, isContainedPath, isMarkdownPath } from "./paths.ts";
import { acquireLock, INDEX_FILE, sha256 } from "./store.ts";
import type { ProjectPaths } from "./types.ts";

export type ReviewPaths = Pick<ProjectPaths, "memoryDir" | "locksDir">;
export type ReviewOutcome = "succeeded" | "failed" | "aborted" | "unavailable";
export type ReviewStatus = "pending" | "accepted" | "rejected" | "failed" | "aborted" | "unavailable";
export interface ReviewProvenance {
	operationId: string;
	sessionId: string;
	role: "extractor" | "dream";
	/** Actual runtime model, not the session's initial model. Null means unavailable. */
	model: { provider: string; id: string } | null;
}
export interface ReviewFile {
	path: string;
	content: string;
	hash: string;
	size: number;
}
export interface ReviewProposal {
	schemaVersion: 1;
	id: string;
	memoryRoot: string;
	createdAt: string;
	finalizedAt: string;
	baselineHash: string;
	/** Existing content has unknown historical authorship. */
	before: ReviewFile[];
	after: ReviewFile[];
	provenance: ReviewProvenance;
	/** Model-attributed text, not verified evidence or a statement by the reviewer. */
	rationale: { text: string; attribution: "runtime-model" | "unavailable" };
	outcome: ReviewOutcome;
	status: ReviewStatus;
	error?: string;
	decision?: { at: string; reason: string };
}
export interface ReviewWorkspace {
	id: string;
	/** Pass this root to existing child tools; never pass the operative root. */
	memoryDir: string;
}
export interface FinalizeReviewInput {
	provenance: ReviewProvenance;
	outcome: ReviewOutcome;
	rationale: string;
	error?: string;
}
export interface ReviewChange {
	path: string;
	before: ReviewFile | null;
	after: ReviewFile | null;
}
export interface ReviewApplyOptions {
	/** Fault-injection/diagnostic seam. Throwing leaves a recoverable journal. */
	onCheckpoint?: (
		event: "journal" | "intent" | "write" | "progress" | "decision",
		path?: string,
	) => void | Promise<void>;
}
interface WorkspaceManifest {
	schemaVersion: 1;
	id: string;
	memoryRoot: string;
	createdAt: string;
	before: ReviewFile[];
}
interface Journal {
	schemaVersion: 1;
	ids: string[];
	completed: string[];
	active: string | null;
	at: string;
}

// Refuse oversized trees instead of silently omitting part of the baseline.
export const REVIEW_LIMITS = { files: 1000, bytes: 16 * 1024 * 1024, entries: 5000, depth: 32 } as const;
const JSON_LIMIT = REVIEW_LIMITS.bytes * 14;
const ID = /^run-[A-Za-z0-9]{6}$/;
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export function reviewStoreDirectory(paths: ReviewPaths): string {
	return join(paths.locksDir, "..", "review");
}
function assertId(id: string): void {
	if (!ID.test(id)) throw new Error("Invalid review proposal ID");
}
function assertRelative(path: string): void {
	if (
		!path ||
		path.includes("\\") ||
		Array.from(path).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === ":",
		) ||
		path.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)) ||
		containsVcsMetadataSegment(path) ||
		!isMarkdownPath(path)
	)
		throw new Error(`Unsafe review Markdown path: ${path}`);
}
async function info(path: string) {
	return lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
}
/** Check every existing ancestor on POSIX too, not just the terminal entry. */
async function safePath(path: string): Promise<void> {
	const absolute = resolve(path);
	let current = parse(absolute).root;
	for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		const entry = await info(current);
		if (entry?.isSymbolicLink()) throw new Error(`Review path traverses a symlink: ${current}`);
		if (entry && current !== absolute && !entry.isDirectory()) throw new Error(`Not a directory: ${current}`);
	}
}
async function directory(path: string): Promise<void> {
	await safePath(path);
	const missing: string[] = [];
	for (let parent = resolve(path); !(await info(parent)); parent = dirname(parent)) missing.push(parent);
	await mkdir(path, { recursive: true, mode: 0o700 });
	await safePath(path);
	if (!(await lstat(path)).isDirectory()) throw new Error(`Not a directory: ${path}`);
	for (const created of missing.reverse()) await syncDirectory(dirname(created));
}
async function privateDirectory(path: string): Promise<void> {
	await directory(path);
	if (process.platform !== "win32" && ((await lstat(path)).mode & 0o077) !== 0)
		throw new Error(`Review directory must be private (mode 0700): ${path}`);
}
async function setup(paths: ReviewPaths): Promise<string> {
	const store = resolve(reviewStoreDirectory(paths));
	const root = resolve(paths.memoryDir);
	if (isContainedPath(root, store) || isContainedPath(store, root))
		throw new Error("Review store and operative memory must be separate");
	await privateDirectory(store);
	await privateDirectory(join(store, "proposals"));
	await privateDirectory(join(store, "workspaces"));
	await directory(paths.locksDir);
	return store;
}
async function readText(path: string, limit: number): Promise<string> {
	await safePath(path);
	const entry = await lstat(path);
	if (!entry.isFile() || entry.size > limit) throw new Error(`Unsafe or oversized review file: ${path}`);
	const handle = await open(path, NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.size > limit) throw new Error(`Unsafe or oversized review file: ${path}`);
		// Bound allocations even if a non-cooperating writer grows the open file.
		const buffer = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		if (
			length !== before.size ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error(`Review file changed while reading: ${path}`);
		const text = buffer.subarray(0, length).toString("utf8");
		if (!Buffer.from(text).equals(buffer.subarray(0, length))) throw new Error(`Review requires valid UTF-8: ${path}`);
		return text;
	} finally {
		await handle.close();
	}
}
async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(path, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function publish(path: string, text: string, exclusive = false, guard?: () => Promise<void>): Promise<void> {
	await directory(dirname(path));
	await safePath(path);
	const temporary = join(dirname(path), `.review-${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(text);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await guard?.();
		await safePath(path);
		if (exclusive) await link(temporary, path);
		else await rename(temporary, path);
		await syncDirectory(dirname(path));
	} finally {
		await rm(temporary, { force: true });
	}
}
async function saveJson(path: string, value: unknown, exclusive = false): Promise<void> {
	const content = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(content) > JSON_LIMIT) throw new Error("Review metadata exceeds byte limit");
	await publish(path, content, exclusive);
}
async function json(path: string): Promise<unknown> {
	return JSON.parse(await readText(path, JSON_LIMIT));
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid review metadata");
	return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
	if (typeof value !== "string") throw new Error("Invalid review text");
}
function metadataText(value: unknown): asserts value is string {
	text(value);
	if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("Review metadata text exceeds byte limit");
}
function date(value: unknown): asserts value is string {
	text(value);
	if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid review timestamp");
}
function provenance(value: unknown): asserts value is ReviewProvenance {
	const record = object(value);
	for (const key of ["operationId", "sessionId"]) {
		metadataText(record[key]);
		if (!record[key]) throw new Error(`Missing runtime ${key}`);
	}
	if (!["extractor", "dream"].includes(String(record.role))) throw new Error("Invalid review role");
	if (record.model !== null) {
		const model = object(record.model);
		metadataText(model.provider);
		metadataText(model.id);
		if (!model.provider || !model.id) throw new Error("Missing runtime model identity");
	}
}
function files(value: unknown): asserts value is ReviewFile[] {
	if (!Array.isArray(value) || value.length > REVIEW_LIMITS.files) throw new Error("Invalid review snapshot");
	let bytes = 0;
	const seen = new Set<string>();
	for (const entry of value) {
		const file = object(entry);
		text(file.path);
		text(file.content);
		text(file.hash);
		assertRelative(file.path);
		const key = process.platform === "win32" ? file.path.toLowerCase() : file.path;
		if (seen.has(key)) throw new Error("Duplicate review path");
		seen.add(key);
		if (file.hash !== sha256(file.content) || file.size !== Buffer.byteLength(file.content))
			throw new Error("Review snapshot hash/size mismatch");
		bytes += file.size as number;
	}
	if (bytes > REVIEW_LIMITS.bytes) throw new Error("Review snapshot exceeds byte limit");
	for (const path of seen) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			if (seen.has(parts.slice(0, i).join("/"))) throw new Error(`Review file/directory collision: ${path}`);
		}
	}
}
function digest(snapshot: ReviewFile[]): string {
	return sha256(
		JSON.stringify(
			[...snapshot].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, hash, size }) => [path, hash, size]),
		),
	);
}
async function snapshot(root: string): Promise<ReviewFile[]> {
	await safePath(root);
	if (!(await lstat(root)).isDirectory()) throw new Error("Memory root is not a directory");
	const result: ReviewFile[] = [];
	let bytes = 0;
	let entries = 0;
	async function walk(parent: string, depth: number): Promise<void> {
		if (depth > REVIEW_LIMITS.depth) throw new Error("Review tree exceeds depth limit");
		for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
			if (++entries > REVIEW_LIMITS.entries) throw new Error("Review tree exceeds entry limit");
			const path = parent ? `${parent}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw new Error(`Review tree contains a symlink: ${path}`);
			if (containsVcsMetadataSegment(path)) continue;
			if (entry.isDirectory()) {
				await safePath(join(root, path));
				await walk(path, depth + 1);
			} else if (isMarkdownPath(path)) {
				assertRelative(path);
				if (!entry.isFile()) throw new Error(`Not regular Markdown: ${path}`);
				const content = await readText(join(root, path), REVIEW_LIMITS.bytes - bytes);
				bytes += Buffer.byteLength(content);
				result.push({ path, content, hash: sha256(content), size: Buffer.byteLength(content) });
				if (result.length > REVIEW_LIMITS.files) throw new Error("Review tree exceeds file limit");
			}
		}
	}
	await walk("", 0);
	result.sort((a, b) => a.path.localeCompare(b.path));
	files(result);
	return result;
}
function same(a: ReviewFile | null, b: ReviewFile | null): boolean {
	return a === null || b === null ? a === b : a.hash === b.hash && a.size === b.size && a.content === b.content;
}
export function reviewChanges(proposal: Pick<ReviewProposal, "before" | "after">): ReviewChange[] {
	const before = new Map(proposal.before.map((file) => [file.path, file]));
	const after = new Map(proposal.after.map((file) => [file.path, file]));
	return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
		const old = before.get(path) ?? null;
		const next = after.get(path) ?? null;
		return same(old, next) ? [] : [{ path, before: old, after: next }];
	});
}

export async function prepareReviewWorkspace(paths: ReviewPaths): Promise<ReviewWorkspace> {
	const store = await setup(paths);
	const root = resolve(paths.memoryDir);
	const before = await snapshot(root);
	const workspace = await mkdtemp(join(store, "workspaces", "run-"));
	await syncDirectory(dirname(workspace));
	const id = workspace.slice(workspace.lastIndexOf(process.platform === "win32" ? "\\" : "/") + 1);
	try {
		const memoryDir = join(workspace, "memory");
		await directory(memoryDir);
		for (const file of before) await publish(join(memoryDir, file.path), file.content, true);
		if (digest(await snapshot(root)) !== digest(before)) throw new Error("Memory changed during review preparation");
		await saveJson(
			join(workspace, "baseline.json"),
			{
				schemaVersion: 1,
				id,
				memoryRoot: root,
				createdAt: new Date().toISOString(),
				before,
			} satisfies WorkspaceManifest,
			true,
		);
		return { id, memoryDir };
	} catch (error) {
		await rm(workspace, { recursive: true, force: true });
		throw error;
	}
}
async function locked<T>(
	paths: ReviewPaths,
	action: (store: string, check: () => Promise<void>) => Promise<T>,
): Promise<T> {
	const store = await setup(paths);
	const lease = await acquireLock(join(paths.locksDir, "review-apply.lock"), 15 * 60_000);
	if (!lease) throw new Error("Another review operation holds the application lock");
	try {
		return await action(store, () => lease.assertValid());
	} finally {
		await lease();
	}
}
function proposalPath(store: string, id: string): string {
	assertId(id);
	return join(store, "proposals", `${id}.json`);
}
async function requireNoJournal(store: string): Promise<void> {
	await safePath(join(store, "journal.json"));
	if (await info(join(store, "journal.json"))) throw new Error("Interrupted review application; run recovery first");
}
export async function finalizeReviewProposal(
	paths: ReviewPaths,
	workspace: ReviewWorkspace,
	input: FinalizeReviewInput,
): Promise<ReviewProposal> {
	assertId(workspace.id);
	provenance(input.provenance);
	if (!["succeeded", "failed", "aborted", "unavailable"].includes(input.outcome))
		throw new Error("Invalid review outcome");
	metadataText(input.rationale);
	if (input.error !== undefined) metadataText(input.error);
	return locked(paths, async (store, check) => {
		const base = join(store, "workspaces", workspace.id);
		if (resolve(workspace.memoryDir) !== join(base, "memory")) throw new Error("Workspace path mismatch");
		const manifest = object(await json(join(base, "baseline.json")));
		if (
			manifest.schemaVersion !== 1 ||
			manifest.id !== workspace.id ||
			manifest.memoryRoot !== resolve(paths.memoryDir)
		)
			throw new Error("Workspace baseline mismatch");
		date(manifest.createdAt);
		files(manifest.before);
		const after = await snapshot(workspace.memoryDir);
		const unavailable = input.outcome === "succeeded" && (input.provenance.model === null || input.error !== undefined);
		const outcome = unavailable ? "unavailable" : input.outcome;
		const proposal: ReviewProposal = {
			schemaVersion: 1,
			id: workspace.id,
			memoryRoot: resolve(paths.memoryDir),
			createdAt: manifest.createdAt,
			finalizedAt: new Date().toISOString(),
			baselineHash: digest(manifest.before),
			before: manifest.before,
			after,
			provenance: structuredClone(input.provenance),
			rationale: { text: input.rationale, attribution: input.provenance.model ? "runtime-model" : "unavailable" },
			outcome,
			status: outcome === "succeeded" ? "pending" : outcome,
			...(input.error === undefined ? {} : { error: input.error }),
		};
		await check();
		await saveJson(proposalPath(store, proposal.id), proposal, true);
		return proposal;
	});
}
async function loadProposal(paths: ReviewPaths, store: string, id: string): Promise<ReviewProposal> {
	const value = object(await json(proposalPath(store, id)));
	if (value.schemaVersion !== 1 || value.id !== id || value.memoryRoot !== resolve(paths.memoryDir))
		throw new Error("Review proposal identity mismatch");
	date(value.createdAt);
	date(value.finalizedAt);
	files(value.before);
	files(value.after);
	provenance(value.provenance);
	if (value.baselineHash !== digest(value.before)) throw new Error("Review baseline digest mismatch");
	if (
		!["succeeded", "failed", "aborted", "unavailable"].includes(String(value.outcome)) ||
		!["pending", "accepted", "rejected", "failed", "aborted", "unavailable"].includes(String(value.status))
	)
		throw new Error("Invalid review outcome/status");
	const rationale = object(value.rationale);
	metadataText(rationale.text);
	if (rationale.attribution !== (value.provenance.model ? "runtime-model" : "unavailable"))
		throw new Error("Invalid rationale attribution");
	if (
		(value.status === "pending" || value.status === "accepted") &&
		(value.outcome !== "succeeded" || value.provenance.model === null || value.error !== undefined)
	)
		throw new Error("Unsuccessful review cannot be accepted");
	if (value.error !== undefined) metadataText(value.error);
	if (value.decision !== undefined) {
		const decision = object(value.decision);
		date(decision.at);
		metadataText(decision.reason);
	}
	return value as unknown as ReviewProposal;
}
export async function readReviewProposal(paths: ReviewPaths, id: string): Promise<ReviewProposal> {
	return loadProposal(paths, await setup(paths), id);
}
/** Corrupt/unsafe records fail closed, rather than disappearing from the list. */
export async function listReviewProposals(paths: ReviewPaths): Promise<ReviewProposal[]> {
	const store = await setup(paths);
	const result: ReviewProposal[] = [];
	for (const name of (await readdir(join(store, "proposals"))).sort()) {
		if (!name.endsWith(".json")) throw new Error(`Unexpected proposal entry: ${name}`);
		result.push(await loadProposal(paths, store, name.slice(0, -5)));
	}
	return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Validate inline links and reference definitions against the complete proposed tree. */
export function validateReviewIndex(snapshot: ReviewFile[]): void {
	const index = snapshot.find((file) =>
		process.platform === "win32" ? file.path.toLowerCase() === "memory.md" : file.path === INDEX_FILE,
	);
	if (!index) return;
	if (/<\s*\/?\s*(?:a|img)\b/i.test(index.content)) throw new Error("Unsupported HTML index link syntax");
	const names = new Set(snapshot.map((file) => (process.platform === "win32" ? file.path.toLowerCase() : file.path)));
	function target(raw: string): void {
		let path: string;
		try {
			path = decodeURIComponent(raw.replace(/^<|>$/g, "").split(/[?#]/)[0] ?? "");
		} catch {
			throw new Error(`Invalid index link: ${raw}`);
		}
		if (!path && raw.startsWith("#")) return;
		if (/^(?:https?:|mailto:)/i.test(path)) return;
		path = path.replace(/^\.\//, "");
		assertRelative(path);
		if (!names.has(process.platform === "win32" ? path.toLowerCase() : path))
			throw new Error(`Index references missing Markdown: ${path}`);
	}
	const definitions = new Map<string, string>();
	const normalize = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();
	let body = index.content.replace(
		/^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)(?:[^\n]*)$/gm,
		(_match, label: string, path: string) => {
			target(path);
			definitions.set(normalize(label), path);
			return "";
		},
	);
	body = body.replace(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\s*\)/g, (_match, path: string) => {
		target(path);
		return "";
	});
	body = body.replace(/!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g, (match, label: string, reference: string | undefined) => {
		const key = normalize(reference || label);
		if (definitions.has(key)) return "";
		if (reference !== undefined) throw new Error(`Undefined index reference: ${key}`);
		return match;
	});
	if (/\]\(/.test(body)) throw new Error("Unsupported or malformed index link syntax");
}
function group(proposals: ReviewProposal[]): { baseline: ReviewFile[]; result: ReviewFile[]; changes: ReviewChange[] } {
	const first = proposals[0];
	if (!first) throw new Error("At least one proposal is required");
	const merged = new Map(first.before.map((file) => [file.path, file]));
	const changes = new Map<string, ReviewChange>();
	for (const proposal of proposals) {
		if (proposal.baselineHash !== first.baselineHash)
			throw new Error("Grouped proposals have different source baselines");
		for (const change of reviewChanges(proposal)) {
			const key = process.platform === "win32" ? change.path.toLowerCase() : change.path;
			if (changes.has(key)) throw new Error(`Grouped proposals overlap: ${change.path}`);
			changes.set(key, change);
			if (change.after) merged.set(change.path, change.after);
			else merged.delete(change.path);
		}
	}
	const result = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
	files(result);
	validateReviewIndex(result);
	// Directory/file transitions cannot be replayed using content-only progress.
	const allPaths = new Set(
		[...first.before, ...result].map((file) => (process.platform === "win32" ? file.path.toLowerCase() : file.path)),
	);
	for (const path of allPaths) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			if (allPaths.has(parts.slice(0, i).join("/"))) throw new Error(`Unsupported file/directory transition: ${path}`);
		}
	}
	return {
		baseline: first.before,
		result,
		changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
	};
}
function idsChecked(ids: readonly string[]): void {
	if (!ids.length || ids.length > REVIEW_LIMITS.files || new Set(ids).size !== ids.length)
		throw new Error("Invalid proposal group");
	for (const id of ids) assertId(id);
}
async function currentFile(root: string, path: string): Promise<ReviewFile | null> {
	const absolute = join(root, path);
	await safePath(absolute);
	if (!(await info(absolute))) return null;
	const content = await readText(absolute, REVIEW_LIMITS.bytes);
	return { path, content, hash: sha256(content), size: Buffer.byteLength(content) };
}
async function applyJournal(
	paths: ReviewPaths,
	store: string,
	journal: Journal,
	check: () => Promise<void>,
	options: ReviewApplyOptions,
): Promise<ReviewProposal[]> {
	const proposals = await Promise.all(journal.ids.map((id) => loadProposal(paths, store, id)));
	if (proposals.some((proposal) => !["pending", "accepted"].includes(proposal.status)))
		throw new Error("Journal proposal is not acceptable");
	const { baseline, result, changes } = group(proposals);
	const completed = new Set(journal.completed);
	if (
		completed.size !== journal.completed.length ||
		[...completed].some((path) => !changes.some((change) => change.path === path))
	)
		throw new Error("Invalid journal progress");
	if (
		journal.active !== null &&
		(!changes.some((change) => change.path === journal.active) || completed.has(journal.active))
	)
		throw new Error("Invalid journal active intent");
	const root = resolve(paths.memoryDir);
	// An intent with old bytes is ambiguous: the write may have happened and
	// then been externally reverted. Never replay over that possible edit.
	if (journal.active !== null) {
		const change = changes.find((change) => change.path === journal.active);
		if (!change || !same(await currentFile(root, change.path), change.after))
			throw new Error(`Recovery conflict: ambiguous write intent ${journal.active}; external edits preserved`);
		// Keep this recognition in every subsequent progress record, even when
		// replay starts by visiting earlier, already-completed group members.
		completed.add(journal.active);
	}
	async function preflight(): Promise<void> {
		const current = await snapshot(root);
		const expected = new Map(baseline.map((file) => [file.path, file]));
		const actual = new Map(current.map((file) => [file.path, file]));
		for (const change of changes) {
			const file = actual.get(change.path) ?? null;
			if (!same(file, completed.has(change.path) ? change.after : change.before))
				throw new Error(`Recovery conflict: ${change.path}; external edits preserved`);
			if (file) expected.set(change.path, file);
			else expected.delete(change.path);
		}
		if (digest([...expected.values()]) !== digest(current))
			throw new Error("Recovery conflict in unchanged baseline; external edits preserved");
	}
	await preflight();
	for (const change of changes) {
		await check();
		await preflight();
		const current = await currentFile(root, change.path);
		if (!same(current, change.after)) {
			journal.active = change.path;
			await check();
			await saveJson(join(store, "journal.json"), journal);
			await options.onCheckpoint?.("intent", change.path);
			const guard = async () => {
				await check();
				await safePath(join(root, change.path));
				if (!same(await currentFile(root, change.path), change.before))
					throw new Error(`Apply conflict: ${change.path}`);
			};
			if (change.after) await publish(join(root, change.path), change.after.content, change.before === null, guard);
			else {
				await guard();
				await rm(join(root, change.path));
				await syncDirectory(dirname(join(root, change.path)));
			}
			await options.onCheckpoint?.("write", change.path);
		}
		completed.add(change.path);
		journal.completed = [...completed];
		journal.active = null;
		await check();
		await saveJson(join(store, "journal.json"), journal);
		await options.onCheckpoint?.("progress", change.path);
	}
	await preflight();
	if (digest(await snapshot(root)) !== digest(result)) throw new Error("Applied review result changed externally");
	for (const proposal of proposals) {
		await check();
		await preflight();
		proposal.status = "accepted";
		proposal.decision = { at: journal.at, reason: "Explicit grouped acceptance" };
		await saveJson(proposalPath(store, proposal.id), proposal);
		await options.onCheckpoint?.("decision", proposal.id);
	}
	await check();
	await preflight();
	await safePath(join(store, "journal.json"));
	await rm(join(store, "journal.json"));
	await syncDirectory(store);
	return proposals;
}
/** Caller owns explicit user confirmation; this must not be exposed as a model tool. */
export async function acceptReviewProposals(
	paths: ReviewPaths,
	ids: readonly string[],
	options: ReviewApplyOptions = {},
): Promise<ReviewProposal[]> {
	idsChecked(ids);
	return locked(paths, async (store, check) => {
		await requireNoJournal(store);
		const proposals = await Promise.all(ids.map((id) => loadProposal(paths, store, id)));
		if (proposals.some((proposal) => proposal.status !== "pending"))
			throw new Error("Only pending proposals can be accepted");
		const { baseline, changes } = group(proposals);
		if (digest(await snapshot(resolve(paths.memoryDir))) !== digest(baseline))
			throw new Error("Proposal baseline conflict; external edits preserved");
		for (const change of changes) {
			if (!same(await currentFile(resolve(paths.memoryDir), change.path), change.before))
				throw new Error(`Proposal target conflict: ${change.path}`);
		}
		const journal: Journal = {
			schemaVersion: 1,
			ids: [...ids],
			completed: [],
			active: null,
			at: new Date().toISOString(),
		};
		await check();
		await saveJson(join(store, "journal.json"), journal, true);
		await options.onCheckpoint?.("journal");
		return applyJournal(paths, store, journal, check, options);
	});
}
export async function rejectReviewProposal(paths: ReviewPaths, id: string, reason = ""): Promise<ReviewProposal> {
	metadataText(reason);
	return locked(paths, async (store, check) => {
		await requireNoJournal(store);
		const proposal = await loadProposal(paths, store, id);
		if (proposal.status !== "pending") throw new Error("Only pending proposals can be rejected");
		proposal.status = "rejected";
		proposal.decision = { at: new Date().toISOString(), reason };
		await check();
		await saveJson(proposalPath(store, id), proposal);
		return proposal;
	});
}
/** Idempotent roll-forward. Conflicts leave both journal and operative edits untouched. */
export async function recoverReviewStore(
	paths: ReviewPaths,
	options: ReviewApplyOptions = {},
): Promise<ReviewProposal[]> {
	return locked(paths, async (store, check) => {
		await safePath(join(store, "journal.json"));
		if (!(await info(join(store, "journal.json")))) return [];
		const value = object(await json(join(store, "journal.json")));
		if (
			value.schemaVersion !== 1 ||
			!Array.isArray(value.ids) ||
			!value.ids.every((id) => typeof id === "string") ||
			(value.active !== null && typeof value.active !== "string") ||
			!Array.isArray(value.completed) ||
			!value.completed.every((path) => typeof path === "string")
		)
			throw new Error("Invalid review journal");
		idsChecked(value.ids);
		date(value.at);
		return applyJournal(paths, store, value as unknown as Journal, check, options);
	});
}
