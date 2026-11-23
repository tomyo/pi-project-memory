import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import extension from "../index.ts";
import { createChildTools } from "../src/child-tools.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runChildAgent } from "../src/models.ts";
import { initializeProjectPaths, resolveProjectPaths } from "../src/paths.ts";
import { mergeMemoryProvenance, PROVENANCE_LOG_MAX_BYTES, writeMemoryWithProvenance } from "../src/provenance.ts";
import { baseline, frontmatterParts, lintMemoryContent, readIndex, scanTopics, sha256 } from "../src/store.ts";
import type { MemoryProvenance } from "../src/types.ts";
import { createToolWorkspace, skipOnWindows } from "./helpers.ts";

const provenance: MemoryProvenance = { role: "extractor", sessionId: "real-session", model: "provider/model/id" };
const at = "2026-11-24T12:00:00.000Z";
function metadata(content: string) {
	return YAML.parse(frontmatterParts(content)!.header);
}
async function entries(locksDir: string) {
	return (await readFile(join(locksDir, "..", "provenance.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

test("merge adds and replaces provenance, preserving all other keys and body bytes", () => {
	const body = "\r\n  # Topic\r\n\r\nindented  \t\r\nno final newline";
	const source = `\uFEFF---\r\nname: topic\r\ndescription: durable hook\r\nmetadata:\r\n  type: feedback\r\ncustom: [one, two]\r\nprovenance:\r\n  role: dream\r\n  model: stale/model\r\n---\r\n${body}`;
	const result = mergeMemoryProvenance(source, provenance, at);
	const { provenance: _old, ...before } = metadata(source);
	const { provenance: recorded, ...after } = metadata(result);
	assert.deepEqual(after, before);
	assert.deepEqual(recorded, { role: "extractor", at, session: "real-session", model: "provider/model/id" });
	assert.deepEqual(Buffer.from(frontmatterParts(result)!.body), Buffer.from(body));
	assert.equal((result.match(/^provenance:/gm) ?? []).length, 1);
	assert.ok(result.startsWith("\uFEFF---\r\n"));
	const updated = mergeMemoryProvenance(result, { ...provenance, role: "dream" }, at);
	assert.equal(metadata(updated).provenance.role, "dream");
	assert.equal(frontmatterParts(updated)!.body, body);
});

test("unattributed files need no migration; plain bodies and empty files survive stamping", () => {
	for (const source of ["", "\n  body\n\n", "---\nname: old\ncustom: true\n---\n\n  body\n\n"]) {
		const expectedBody = frontmatterParts(source)?.body ?? source;
		const stamped = mergeMemoryProvenance(source, provenance, at);
		assert.deepEqual(Buffer.from(frontmatterParts(stamped)!.body), Buffer.from(expectedBody));
		assert.equal(metadata(stamped).provenance.session, "real-session");
		if (source.startsWith("---")) assert.equal(metadata(stamped).custom, true);
	}
});

test("agent attribution and unknown model omission replace stale model values", () => {
	const first = mergeMemoryProvenance("body", provenance, at);
	const result = mergeMemoryProvenance(first, { role: "agent", sessionId: "parent-session", model: "" }, at);
	assert.deepEqual(metadata(result).provenance, { role: "agent", at, session: "parent-session" });
});

test("invalid or unterminated frontmatter fails closed without rewriting the file", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-invalid-");
	const path = join(env.memoryDir, "topic.md");
	for (const content of ["---\nname: [broken\n---\nbody", "---\nname: unterminated", "---\n- sequence\n---\nbody"]) {
		await writeFile(path, content);
		await assert.rejects(
			writeMemoryWithProvenance(path, await baseline(path), content, { ...env, path: "topic.md", provenance }),
		);
		assert.equal(await readFile(path, "utf8"), content);
	}
});

test("child create/update/edit/delete records actual hashes and one audit row per operation", async (t) => {
	if (skipOnWindows(t, "POSIX rm fixture; Windows deletion has separate child-tool coverage")) return;
	const env = await createToolWorkspace(t, "pi-provenance-child-");
	const touchedPaths = new Set<string>();
	const tools = new Map(
		createChildTools({
			...env,
			mode: "extractor",
			cwd: env.projectRoot,
			provenance,
			isCurrentGeneration: () => true,
			touchedPaths,
		}).map((tool) => [tool.name, tool]),
	);
	const path = join(env.memoryDir, "topic.md");
	const execute = async (name: string, input: any) => {
		const result = await tools.get(name)!.execute(name, input);
		assert.notEqual(result.isError, true, JSON.stringify(result));
	};
	const body = "---\nname: topic\ndescription: durable hook\nmetadata:\n  type: feedback\n---\n\nbody\n";
	await execute("write", { path, content: body });
	const created = await readFile(path, "utf8");
	await execute("write", { path, content: body.replace("body", "replacement") });
	const updated = await readFile(path, "utf8");
	await execute("edit", { path, edits: [{ oldText: "replacement", newText: "edited" }] });
	const edited = await readFile(path, "utf8");
	await execute("bash", { command: `rm '${path}'` });
	await assert.rejects(readFile(path), { code: "ENOENT" });
	const rows = await entries(env.locksDir);
	assert.equal(rows.length, 4);
	assert.deepEqual(
		rows.map(({ action, baseline, result }) => ({ action, baseline, result })),
		[
			{ action: "create", baseline: null, result: sha256(created) },
			{ action: "update", baseline: sha256(created), result: sha256(updated) },
			{ action: "update", baseline: sha256(updated), result: sha256(edited) },
			{ action: "delete", baseline: sha256(edited), result: null },
		],
	);
	for (const row of rows) {
		assert.equal(row.role, "extractor");
		assert.equal(row.session, provenance.sessionId);
		assert.equal(row.model, provenance.model);
		assert.equal(row.path, "topic.md");
		assert.equal(new Date(row.at).toISOString(), row.at);
	}
	assert.equal(metadata(created).provenance.at, rows[0].at);
	assert.deepEqual([...touchedPaths], ["topic.md"]);
	assert.equal((await stat(join(env.root, "provenance.jsonl"))).mode & 0o777, 0o600);
});

test("Dream adds provenance to an existing unattributed topic and scan/index/lint still work", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-dream-");
	const path = join(env.memoryDir, "topic.md");
	const original = "---\nname: topic\ndescription: durable hook\nmetadata:\n  type: feedback\n---\n\nbody\n";
	await writeFile(path, original);
	await writeMemoryWithProvenance(path, await baseline(path), original, {
		...env,
		path: "topic.md",
		provenance: { ...provenance, role: "dream", model: "" },
	});
	const written = await readFile(path, "utf8");
	assert.equal(frontmatterParts(written)!.body, frontmatterParts(original)!.body);
	assert.equal(metadata(written).provenance.role, "dream");
	const rows = await entries(env.locksDir);
	assert.equal(rows[0].baseline, sha256(original));
	assert.equal(rows[0].result, sha256(written));
	assert.equal(rows[0].action, "update");
	assert.equal(Object.hasOwn(rows[0], "model"), false);
	const topics = await scanTopics(env.memoryDir);
	assert.equal(topics.length, 1);
	assert.equal(topics[0]!.description, "durable hook");
	assert.equal(topics[0]!.type, "feedback");
	assert.deepEqual(lintMemoryContent(path, written), []);
	assert.match(await readIndex(env.memoryDir), /\[topic\]\(topic.md\).*durable hook/);
});

test("audit rotates at 5 MiB and replaces its single previous segment", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-rotation-");
	const log = join(env.root, "provenance.jsonl");
	const full = `${JSON.stringify({ padding: "x".repeat(PROVENANCE_LOG_MAX_BYTES - 15) })}\n`;
	await writeFile(log, full, { mode: 0o600 });
	await writeFile(`${log}.1`, "obsolete rotation");
	const path = join(env.memoryDir, "topic.md");
	await writeMemoryWithProvenance(path, null, "body", { ...env, path: "topic.md", provenance });
	assert.equal(await readFile(`${log}.1`, "utf8"), full);
	assert.equal((await entries(env.locksDir)).length, 1);
	assert.equal((await stat(log)).mode & 0o777, process.platform === "win32" ? (await stat(log)).mode & 0o777 : 0o600);
	assert.ok((await stat(log)).size < 1024);
});

test("audit append/rotation failures never block successful writes or deletion", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-failure-");
	// A directory at the log path reliably fails even when tests run as root.
	await mkdir(join(env.root, "provenance.jsonl"));
	const path = join(env.memoryDir, "topic.md");
	const tools = new Map(
		createChildTools({
			...env,
			mode: "dream",
			cwd: env.projectRoot,
			provenance: { ...provenance, role: "dream" },
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}).map((tool) => [tool.name, tool]),
	);
	for (const content of ["created", "updated"]) {
		const result = await tools.get("write")!.execute("write", { path, content });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.equal(frontmatterParts(await readFile(path, "utf8"))!.body, content);
	}
	if (process.platform !== "win32") {
		const result = await tools.get("bash")!.execute("delete", { command: `rm '${path}'` });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		await assert.rejects(readFile(path), { code: "ENOENT" });
	}
});

test("parent native write/edit hooks stamp agent provenance and audit pre-operation hashes", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-parent-");
	const agent = join(env.root, "agent");
	await mkdir(join(agent, "project-memory"), { recursive: true });
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(() => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
	});
	await writeFile(
		join(agent, "project-memory", "config.json"),
		JSON.stringify({ ...DEFAULT_CONFIG, extraction: { ...DEFAULT_CONFIG.extraction, enabled: false } }),
	);
	const paths = await resolveProjectPaths(env.projectRoot, null);
	await initializeProjectPaths(paths);
	const handlers = new Map<string, any>();
	const api = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		getSettings: () => ({}),
		getActiveTools: () => [],
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: env.projectRoot,
		hasUI: false,
		isProjectTrusted: () => true,
		model: { provider: "parent-provider", id: "parent-model" },
		sessionManager: {
			getSessionId: () => "parent-session",
			getBranch: () => [],
			buildSessionProjection: () => ({ messages: [], entries: [] }),
		},
	} as unknown as ExtensionContext;
	extension(api);
	await handlers.get("session_start")({}, ctx);
	const path = join(paths.memoryDir, "topic.md");
	let previous: string | null = null;
	for (const toolName of ["write", "edit"]) {
		const input = { path, content: "---\ndescription: parent hook\n---\n\nbody\n" };
		await handlers.get("tool_call")({ toolName, toolCallId: toolName, input }, ctx);
		await writeFile(path, input.content);
		await handlers.get("tool_result")(
			{ toolName, toolCallId: toolName, input, content: [{ type: "text", text: "done" }], isError: false },
			ctx,
		);
		const written = await readFile(path, "utf8");
		assert.deepEqual(metadata(written).provenance, {
			role: "agent",
			at: metadata(written).provenance.at,
			session: "parent-session",
			model: "parent-provider/parent-model",
		});
		assert.equal(frontmatterParts(written)!.body, "\nbody\n");
		const row = (await entries(paths.locksDir)).at(-1)!;
		assert.equal(row.action, previous === null ? "create" : "update");
		assert.equal(row.baseline, previous === null ? null : sha256(previous));
		assert.equal(row.result, sha256(written));
		previous = written;
	}
});

test("background runtime stamps the resolved role model, not the parent or configured alias", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-runtime-");
	const faux = createFauxCore({ provider: "runtime-provider", models: [{ id: "actual/model", reasoning: false }] });
	const model = faux.getModel();
	for (const role of ["extractor", "dream"] as const) {
		const config = structuredClone(DEFAULT_CONFIG);
		config.models[role].model = "runtime-provider/actual/model";
		const path = join(env.memoryDir, `${role}.md`);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "durable fact\n" })),
			fauxAssistantMessage("done"),
		]);
		await runChildAgent({
			role,
			prompt: "save",
			systemPrompt: "system",
			sourceMessages: [],
			config,
			paths: { ...env, projectKey: "test", baseDir: env.root, stateFile: join(env.root, "state.json") },
			isCurrentGeneration: () => true,
			ctx: {
				cwd: env.projectRoot,
				model: { ...model, provider: "parent-provider", id: "parent-model" },
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "actual-session" },
				modelRegistry: { find: () => model, hasConfiguredAuth: () => true, streamSimple: faux.streamSimple },
			} as unknown as ExtensionContext,
		});
		const written = await readFile(path, "utf8");
		const recorded = metadata(written).provenance;
		assert.equal(recorded.role, role);
		assert.equal(recorded.session, "actual-session");
		assert.equal(recorded.model, "runtime-provider/actual/model");
		const row = (await entries(env.locksDir)).at(-1)!;
		assert.equal(row.model, recorded.model);
		assert.equal(row.role, role);
		assert.equal(row.result, sha256(written));
	}
});

test("failed audit rotation still publishes the new memory content", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-rotation-failure-");
	const log = join(env.root, "provenance.jsonl");
	await writeFile(log, "x".repeat(PROVENANCE_LOG_MAX_BYTES), { mode: 0o600 });
	await mkdir(`${log}.1`);
	await writeFile(join(`${log}.1`, "block-removal"), "keep");
	const path = join(env.memoryDir, "topic.md");
	const written = await writeMemoryWithProvenance(path, null, "body", { ...env, path: "topic.md", provenance });
	assert.equal(sha256(await readFile(path)), written.hash);
	assert.equal(frontmatterParts(written.content)!.body, "body");
	assert.equal((await stat(log)).size, PROVENANCE_LOG_MAX_BYTES);
});

test("stale baseline writes do not overwrite external edits or append false audit entries", async (t) => {
	const env = await createToolWorkspace(t, "pi-provenance-conflict-");
	const path = join(env.memoryDir, "topic.md");
	await writeMemoryWithProvenance(path, null, "original", { ...env, path: "topic.md", provenance });
	const expected = await baseline(path);
	await writeFile(path, "external edit");
	// A fresh external mtime must be later than the authorized read.
	expected.mtimeMs = 0;
	await assert.rejects(
		writeMemoryWithProvenance(path, expected, "replacement", { ...env, path: "topic.md", provenance }),
		/modified since it was read/,
	);
	assert.equal(await readFile(path, "utf8"), "external edit");
	assert.equal((await entries(env.locksDir)).length, 1);
});
