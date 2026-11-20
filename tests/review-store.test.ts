import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	acceptReviewProposals,
	type FinalizeReviewInput,
	finalizeReviewProposal,
	listReviewProposals,
	prepareReviewWorkspace,
	REVIEW_LIMITS,
	type ReviewApplyOptions,
	type ReviewFile,
	readReviewProposal,
	recoverReviewStore,
	rejectReviewProposal,
	reviewChanges,
	reviewStoreDirectory,
	validateReviewIndex,
} from "../src/review-store.ts";
import { acquireLock, sha256 } from "../src/store.ts";
import { createToolWorkspace } from "./helpers.ts";

const input: FinalizeReviewInput = {
	provenance: {
		operationId: "op-1",
		sessionId: "session-1",
		role: "extractor",
		model: { provider: "test", id: "runtime-model" },
	},
	outcome: "succeeded",
	rationale: "Model says this change follows the current session.",
};
function file(path: string, content: string): ReviewFile {
	return { path, content, hash: sha256(content), size: Buffer.byteLength(content) };
}
async function proposal(
	paths: { memoryDir: string; locksDir: string },
	edits: Record<string, string | null>,
	metadata = input,
) {
	const workspace = await prepareReviewWorkspace(paths);
	for (const [path, content] of Object.entries(edits)) {
		const absolute = join(workspace.memoryDir, path);
		if (content === null) await rm(absolute);
		else {
			await mkdir(join(absolute, ".."), { recursive: true });
			await writeFile(absolute, content);
		}
	}
	return finalizeReviewProposal(paths, workspace, metadata);
}
function interrupt(
	event: Parameters<NonNullable<ReviewApplyOptions["onCheckpoint"]>>[0],
	count = 1,
): ReviewApplyOptions {
	let calls = 0;
	return {
		onCheckpoint: (actual) => {
			if (actual === event && ++calls === count) throw new Error("injected interruption");
		},
	};
}

test("staging isolates operative memory and persists exact content, baseline, provenance, and history", async (t) => {
	const paths = await createToolWorkspace(t, "review-stage-");
	await writeFile(join(paths.memoryDir, "MEMORY.md"), "- [Fact](nested/fact.md)\n");
	await mkdir(join(paths.memoryDir, "nested"));
	const original = "---\r\ndescription: fact\r\n---\r\nOriginal.\r\n";
	await writeFile(join(paths.memoryDir, "nested/fact.md"), original);
	await writeFile(join(paths.memoryDir, "ignored.txt"), "not Markdown");
	const workspace = await prepareReviewWorkspace(paths);
	assert.ok(workspace.memoryDir.startsWith(join(paths.root, "review", "workspaces")));
	assert.deepEqual((await readdir(workspace.memoryDir)).sort(), ["MEMORY.md", "nested"]);
	await writeFile(join(workspace.memoryDir, "nested/fact.md"), "Revised.\n");
	const stored = await finalizeReviewProposal(paths, workspace, input);
	assert.equal(await readFile(join(paths.memoryDir, "nested/fact.md"), "utf8"), original);
	assert.equal(stored.before.find((entry) => entry.path === "nested/fact.md")?.content, original);
	assert.equal(stored.after.find((entry) => entry.path === "nested/fact.md")?.content, "Revised.\n");
	assert.deepEqual(stored.provenance, input.provenance);
	assert.equal(stored.rationale.attribution, "runtime-model");
	assert.equal(stored.rationale.text, input.rationale);
	assert.equal(stored.status, "pending");
	assert.equal(reviewChanges(stored).length, 1);
	assert.deepEqual(await readReviewProposal(paths, stored.id), stored);
	assert.deepEqual(await listReviewProposals(paths), [stored]);
	await assert.rejects(finalizeReviewProposal(paths, workspace, input), { code: "EEXIST" });
	await writeFile(join(workspace.memoryDir, "nested/fact.md"), "later staged write");
	assert.equal((await readReviewProposal(paths, stored.id)).after[1]?.content, "Revised.\n");
	if (process.platform !== "win32") {
		assert.equal(
			(await lstat(join(reviewStoreDirectory(paths), "proposals", `${stored.id}.json`))).mode & 0o777,
			0o600,
		);
		assert.equal((await lstat(reviewStoreDirectory(paths))).mode & 0o777, 0o700);
	}
});

test("failed, aborted, unavailable, and missing-runtime-model passes are never acceptable", async (t) => {
	const paths = await createToolWorkspace(t, "review-outcomes-");
	for (const outcome of ["failed", "aborted", "unavailable"] as const) {
		const stored = await proposal(paths, { "fact.md": outcome }, { ...input, outcome, error: "run did not finish" });
		assert.equal(stored.status, outcome);
		assert.equal(stored.error, "run did not finish");
		await assert.rejects(acceptReviewProposals(paths, [stored.id]), /Only pending/);
	}
	const unknown = await proposal(
		paths,
		{ "fact.md": "unknown" },
		{ ...input, provenance: { ...input.provenance, model: null } },
	);
	assert.equal(unknown.status, "unavailable");
	assert.equal(unknown.rationale.attribution, "unavailable");
	const errored = await proposal(paths, { "fact.md": "error" }, { ...input, error: "tool failed" });
	assert.equal(errored.status, "unavailable");
	await assert.rejects(acceptReviewProposals(paths, [unknown.id]), /Only pending/);
	await assert.rejects(acceptReviewProposals(paths, [errored.id]), /Only pending/);
	assert.deepEqual(await readdir(paths.memoryDir), []);
});

test("an unfinished workspace is not a proposal and provenance is validated at runtime", async (t) => {
	const paths = await createToolWorkspace(t, "review-unfinished-");
	const workspace = await prepareReviewWorkspace(paths);
	assert.deepEqual(await listReviewProposals(paths), []);
	await assert.rejects(acceptReviewProposals(paths, [workspace.id]), { code: "ENOENT" });
	await assert.rejects(
		finalizeReviewProposal(paths, workspace, { ...input, provenance: { ...input.provenance, operationId: "" } }),
		/Missing runtime/,
	);
	await assert.rejects(
		finalizeReviewProposal(paths, { ...workspace, memoryDir: paths.memoryDir }, input),
		/Workspace path mismatch/,
	);
});

test("accept applies create, replace, and delete together and retains recoverable diffs", async (t) => {
	const paths = await createToolWorkspace(t, "review-accept-");
	await writeFile(join(paths.memoryDir, "MEMORY.md"), "- [Old](old.md)\n");
	await writeFile(join(paths.memoryDir, "old.md"), "old\n");
	const stored = await proposal(paths, {
		"MEMORY.md": "- [New](nested/new.md)\n",
		"old.md": null,
		"nested/new.md": "new\n",
	});
	const [accepted] = await acceptReviewProposals(paths, [stored.id]);
	assert.equal(accepted?.status, "accepted");
	assert.equal(accepted?.outcome, "succeeded");
	assert.equal(await readFile(join(paths.memoryDir, "nested/new.md"), "utf8"), "new\n");
	await assert.rejects(readFile(join(paths.memoryDir, "old.md")), { code: "ENOENT" });
	assert.equal(
		(await readReviewProposal(paths, stored.id)).before.find((entry) => entry.path === "old.md")?.content,
		"old\n",
	);
	await assert.rejects(acceptReviewProposals(paths, [stored.id]), /Only pending/);
	assert.deepEqual(await recoverReviewStore(paths), []);
	assert.deepEqual(await readdir(reviewStoreDirectory(paths)), ["proposals", "workspaces"]);
});

test("rejection is terminal and does not change operative memory", async (t) => {
	const paths = await createToolWorkspace(t, "review-reject-");
	const stored = await proposal(paths, { "fact.md": "proposed" });
	const rejected = await rejectReviewProposal(paths, stored.id, "Not supported by this session");
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.decision?.reason, "Not supported by this session");
	assert.deepEqual(await readdir(paths.memoryDir), []);
	await assert.rejects(rejectReviewProposal(paths, stored.id), /Only pending/);
	await assert.rejects(acceptReviewProposals(paths, [stored.id]), /Only pending/);
});

test("full baseline conflicts fail before any member is changed, including unrelated files and new files", async (t) => {
	for (const conflict of ["modify", "delete", "add", "unrelated"] as const) {
		await t.test(conflict, async (t) => {
			const paths = await createToolWorkspace(t, "review-conflict-");
			await writeFile(join(paths.memoryDir, "a.md"), "before a");
			await writeFile(join(paths.memoryDir, "z.md"), "before z");
			const stored = await proposal(paths, { "a.md": "after a", "z.md": "after z", "new.md": "new" });
			if (conflict === "delete") await rm(join(paths.memoryDir, "z.md"));
			else
				await writeFile(
					join(paths.memoryDir, conflict === "modify" ? "z.md" : conflict === "add" ? "new.md" : "unrelated.md"),
					"external",
				);
			await assert.rejects(acceptReviewProposals(paths, [stored.id]), /baseline conflict/);
			assert.equal(await readFile(join(paths.memoryDir, "a.md"), "utf8"), "before a");
			assert.equal((await readReviewProposal(paths, stored.id)).status, "pending");
			await assert.rejects(readFile(join(reviewStoreDirectory(paths), "journal.json")), { code: "ENOENT" });
		});
	}
});

test("grouped index/topic changes validate the combined result, not each intermediate proposal", async (t) => {
	const paths = await createToolWorkspace(t, "review-group-");
	await writeFile(join(paths.memoryDir, "MEMORY.md"), "- [Old](old.md)\n");
	await writeFile(join(paths.memoryDir, "old.md"), "old");
	const topics = await proposal(paths, { "old.md": null, "new.md": "new" });
	const index = await proposal(paths, { "MEMORY.md": "- [New][current]\n\n[current]: new.md\n" });
	await assert.rejects(acceptReviewProposals(paths, [topics.id]), /missing Markdown/);
	await assert.rejects(acceptReviewProposals(paths, [index.id]), /missing Markdown/);
	await acceptReviewProposals(paths, [topics.id, index.id]);
	assert.equal(await readFile(join(paths.memoryDir, "new.md"), "utf8"), "new");
	assert.equal((await readReviewProposal(paths, topics.id)).status, "accepted");
	assert.equal((await readReviewProposal(paths, index.id)).status, "accepted");
});

test("group conflicts, duplicates, and different source snapshots cannot partially apply", async (t) => {
	const paths = await createToolWorkspace(t, "review-overlap-");
	const a = await proposal(paths, { "a.md": "a" });
	const b = await proposal(paths, { "a.md": "b" });
	await assert.rejects(acceptReviewProposals(paths, []), /Invalid proposal group/);
	await assert.rejects(acceptReviewProposals(paths, [a.id, a.id]), /Invalid proposal group/);
	await assert.rejects(acceptReviewProposals(paths, [a.id, b.id]), /overlap/);
	assert.deepEqual(await readdir(paths.memoryDir), []);
	await writeFile(join(paths.memoryDir, "existing.md"), "external");
	const c = await proposal(paths, { "c.md": "c" });
	await assert.rejects(acceptReviewProposals(paths, [a.id, c.id]), /different source baselines/);
	assert.deepEqual(await readdir(paths.memoryDir), ["existing.md"]);
});

test("index validator checks unchanged index, definitions, traversal, malformed syntax and encoded targets", () => {
	for (const content of [
		"[x](missing.md)",
		"[x](../outside.md)",
		"[x](%2e%2e/outside.md)",
		"[x](/outside.md)",
		"[x](file:///outside.md)",
		"[x](topic.txt)",
		"[x][absent]",
		"[x](topic.md",
		"[x](<missing.md>)",
		"[x]: missing.md\n",
	]) {
		assert.throws(() => validateReviewIndex([file("MEMORY.md", content), file("topic.md", "topic")]));
	}
	validateReviewIndex([
		file(
			"MEMORY.md",
			"[x](./topic.md#section) [x](https://example.org) [mail](mailto:a@b) [anchor](#x) [topic][]\n[topic]: topic.md\n",
		),
		file("topic.md", "topic"),
	]);
	validateReviewIndex([file("MEMORY.md", '[x](<nested/a%20b.md> "title")'), file("nested/a b.md", "topic")]);
});

test("all review mutations share the existing lock and refuse an active owner", async (t) => {
	const paths = await createToolWorkspace(t, "review-lock-");
	const stored = await proposal(paths, { "fact.md": "proposal" });
	const release = await acquireLock(join(paths.locksDir, "review-apply.lock"), 15 * 60_000);
	assert.ok(release);
	try {
		await assert.rejects(acceptReviewProposals(paths, [stored.id]), /application lock/);
		await assert.rejects(rejectReviewProposal(paths, stored.id), /application lock/);
		await assert.rejects(recoverReviewStore(paths), /application lock/);
	} finally {
		await release();
	}
	await rejectReviewProposal(paths, stored.id);
});

test("recovery rolls forward after journal, write-before-marker, progress, and partial decision interruption", async (t) => {
	for (const event of ["journal", "write", "progress", "decision"] as const) {
		await t.test(event, async (t) => {
			const paths = await createToolWorkspace(t, "review-recover-");
			await writeFile(join(paths.memoryDir, "a.md"), "before a");
			await writeFile(join(paths.memoryDir, "delete.md"), "delete me");
			const a = await proposal(paths, { "a.md": "after a", "delete.md": null });
			const b = await proposal(paths, { "z.md": "new z" });
			await assert.rejects(acceptReviewProposals(paths, [a.id, b.id], interrupt(event)), /injected interruption/);
			await assert.rejects(rejectReviewProposal(paths, b.id), /recovery first/);
			await assert.rejects(acceptReviewProposals(paths, [b.id]), /recovery first/);
			assert.equal((await recoverReviewStore(paths)).length, 2);
			assert.equal(await readFile(join(paths.memoryDir, "a.md"), "utf8"), "after a");
			assert.equal(await readFile(join(paths.memoryDir, "z.md"), "utf8"), "new z");
			await assert.rejects(readFile(join(paths.memoryDir, "delete.md")), { code: "ENOENT" });
			assert.equal((await readReviewProposal(paths, a.id)).status, "accepted");
			assert.equal((await readReviewProposal(paths, b.id)).status, "accepted");
			assert.deepEqual(await recoverReviewStore(paths), []);
		});
	}
});

test("recovery recognizes an interrupted delete or create before its progress marker", async (t) => {
	for (const operation of ["delete", "create"] as const) {
		await t.test(operation, async (t) => {
			const paths = await createToolWorkspace(t, "review-recover-one-");
			if (operation === "delete") await writeFile(join(paths.memoryDir, "a.md"), "before");
			const stored = await proposal(paths, { "a.md": operation === "delete" ? null : "after" });
			await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("write")), /injected/);
			await recoverReviewStore(paths);
			assert.equal((await readReviewProposal(paths, stored.id)).status, "accepted");
		});
	}
});

test("recovery preflights the whole group and never overwrites external edits", async (t) => {
	for (const externalPath of ["a.md", "z.md", "unrelated.md"]) {
		await t.test(externalPath, async (t) => {
			const paths = await createToolWorkspace(t, "review-recover-conflict-");
			await writeFile(join(paths.memoryDir, "a.md"), "before a");
			await writeFile(join(paths.memoryDir, "z.md"), "before z");
			const stored = await proposal(paths, { "a.md": "after a", "z.md": "after z" });
			await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("write")), /injected/);
			await writeFile(join(paths.memoryDir, externalPath), "external edit");
			const before = await Promise.all(
				(await readdir(paths.memoryDir)).map(async (path) => [
					path,
					await readFile(join(paths.memoryDir, path), "utf8"),
				]),
			);
			await assert.rejects(recoverReviewStore(paths), /Recovery conflict/);
			const after = await Promise.all(
				(await readdir(paths.memoryDir)).map(async (path) => [
					path,
					await readFile(join(paths.memoryDir, path), "utf8"),
				]),
			);
			assert.deepEqual(after, before);
			assert.equal((await readReviewProposal(paths, stored.id)).status, "pending");
			assert.ok(await lstat(join(reviewStoreDirectory(paths), "journal.json")));
		});
	}
});

test("external edits during apply are caught before further writes or accepted status", async (t) => {
	const paths = await createToolWorkspace(t, "review-during-apply-");
	await writeFile(join(paths.memoryDir, "a.md"), "before a");
	await writeFile(join(paths.memoryDir, "z.md"), "before z");
	const stored = await proposal(paths, { "a.md": "after a", "z.md": "after z" });
	await assert.rejects(
		acceptReviewProposals(paths, [stored.id], {
			onCheckpoint: async (event) => {
				if (event === "write") await writeFile(join(paths.memoryDir, "z.md"), "external edit");
			},
		}),
		/Recovery conflict/,
	);
	assert.equal(await readFile(join(paths.memoryDir, "z.md"), "utf8"), "external edit");
	assert.equal((await readReviewProposal(paths, stored.id)).status, "pending");
});

test("unsafe IDs, tampered hashes and malformed journal fail closed", async (t) => {
	const paths = await createToolWorkspace(t, "review-corrupt-");
	const stored = await proposal(paths, { "fact.md": "proposal" });
	for (const id of ["../outside", "run-../../x", "run-ABCDEF.json", "", "/tmp/x"]) {
		await assert.rejects(readReviewProposal(paths, id), /Invalid review proposal ID/);
		await assert.rejects(rejectReviewProposal(paths, id), /Invalid review proposal ID/);
	}
	const target = join(reviewStoreDirectory(paths), "proposals", `${stored.id}.json`);
	await writeFile(target, JSON.stringify({ ...stored, after: [{ ...stored.after[0], content: "tampered" }] }));
	await assert.rejects(readReviewProposal(paths, stored.id), /hash\/size mismatch/);
	await assert.rejects(listReviewProposals(paths), /hash\/size mismatch/);
	await writeFile(
		join(reviewStoreDirectory(paths), "journal.json"),
		JSON.stringify({ schemaVersion: 1, ids: [stored.id], completed: ["../escape"], active: null, at: "bad" }),
	);
	await assert.rejects(recoverReviewStore(paths), /timestamp/);
	assert.deepEqual(await readdir(paths.memoryDir), []);
});

test("symlinked memory, staging, proposal, store, lock, and nested parents are rejected", async (t) => {
	for (const position of ["memory", "staging", "proposal", "store", "lock", "nested", "journal"] as const) {
		await t.test(position, async (t) => {
			const paths = await createToolWorkspace(t, "review-symlink-");
			const outside = join(paths.root, "outside");
			await mkdir(outside);
			const stored = await proposal(paths, { "nested/fact.md": "proposal" });
			const store = reviewStoreDirectory(paths);
			let target: string;
			if (position === "proposal") target = join(store, "proposals", `${stored.id}.json`);
			else if (position === "staging") target = join(store, "workspaces", stored.id, "memory");
			else if (position === "memory") target = paths.memoryDir;
			else if (position === "store") target = store;
			else if (position === "lock") target = paths.locksDir;
			else if (position === "nested") target = join(paths.memoryDir, "nested");
			else target = join(store, "journal.json");
			await rm(target, { recursive: true, force: true });
			await symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
			if (position === "staging")
				await assert.rejects(finalizeReviewProposal(paths, { id: stored.id, memoryDir: target }, input), /symlink/);
			else if (position === "journal") await assert.rejects(recoverReviewStore(paths), /symlink/);
			else await assert.rejects(acceptReviewProposals(paths, [stored.id]), /symlink/);
			assert.deepEqual(await readdir(outside), []);
		});
	}
});

test("bounded snapshots reject oversized data and invalid UTF-8 instead of silently truncating", async (t) => {
	const paths = await createToolWorkspace(t, "review-bounds-");
	await writeFile(join(paths.memoryDir, "large.md"), Buffer.alloc(REVIEW_LIMITS.bytes + 1, 97));
	await assert.rejects(prepareReviewWorkspace(paths), /oversized/);
	await writeFile(join(paths.memoryDir, "large.md"), Buffer.from([0xff]));
	await assert.rejects(prepareReviewWorkspace(paths), /valid UTF-8/);
	await rm(join(paths.memoryDir, "large.md"));
	await Promise.all(
		Array.from({ length: REVIEW_LIMITS.files + 1 }, (_, i) => writeFile(join(paths.memoryDir, `${i}.md`), "")),
	);
	await assert.rejects(prepareReviewWorkspace(paths), /file limit/);
});

test("store cannot be placed among recalled Markdown or contain operative memory", async (t) => {
	const paths = await createToolWorkspace(t, "review-overlap-root-");
	await assert.rejects(
		prepareReviewWorkspace({ memoryDir: paths.memoryDir, locksDir: join(paths.memoryDir, "locks") }),
		/must be separate/,
	);
	await assert.rejects(
		prepareReviewWorkspace({ memoryDir: join(paths.root, "review", "memory"), locksDir: paths.locksDir }),
		/must be separate/,
	);
});

test("grouped file/directory collisions and unsupported path transitions fail before journaling", async (t) => {
	const paths = await createToolWorkspace(t, "review-path-shape-");
	const a = await proposal(paths, { "topic.md": "file" });
	const b = await proposal(paths, { "topic.md/nested.md": "nested" });
	await assert.rejects(acceptReviewProposals(paths, [a.id, b.id]), /collision/);
	assert.deepEqual(await readdir(paths.memoryDir), []);
	await assert.rejects(readFile(join(reviewStoreDirectory(paths), "journal.json")), { code: "ENOENT" });
	await writeFile(join(paths.memoryDir, "topic.md"), "original file");
	const workspace = await prepareReviewWorkspace(paths);
	await rm(join(workspace.memoryDir, "topic.md"));
	await mkdir(join(workspace.memoryDir, "topic.md"));
	await writeFile(join(workspace.memoryDir, "topic.md/nested.md"), "nested");
	const transition = await finalizeReviewProposal(paths, workspace, input);
	await assert.rejects(acceptReviewProposals(paths, [transition.id]), /Unsupported file\/directory transition/);
	assert.equal(await readFile(join(paths.memoryDir, "topic.md"), "utf8"), "original file");
});

test("existing empty directories occupying new file paths fail before journaling", async (t) => {
	const paths = await createToolWorkspace(t, "review-directory-target-");
	const stored = await proposal(paths, { "new.md": "new file" });
	await mkdir(join(paths.memoryDir, "new.md"));
	await assert.rejects(acceptReviewProposals(paths, [stored.id]), /Unsafe or oversized/);
	await assert.rejects(readFile(join(reviewStoreDirectory(paths), "journal.json")), { code: "ENOENT" });
	assert.ok((await lstat(join(paths.memoryDir, "new.md"))).isDirectory());
});

test("oversized model metadata cannot create an unreadable proposal", async (t) => {
	const paths = await createToolWorkspace(t, "review-metadata-limit-");
	const workspace = await prepareReviewWorkspace(paths);
	await assert.rejects(
		finalizeReviewProposal(paths, workspace, { ...input, rationale: "x".repeat(1024 * 1024 + 1) }),
		/metadata text exceeds/,
	);
	assert.deepEqual(await listReviewProposals(paths), []);
});

test("completed progress never replays over an external revert to old content", async (t) => {
	const paths = await createToolWorkspace(t, "review-revert-");
	await writeFile(join(paths.memoryDir, "fact.md"), "before");
	const stored = await proposal(paths, { "fact.md": "after" });
	await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("progress")), /injected/);
	await writeFile(join(paths.memoryDir, "fact.md"), "before");
	await assert.rejects(recoverReviewStore(paths), /Recovery conflict/);
	assert.equal(await readFile(join(paths.memoryDir, "fact.md"), "utf8"), "before");
});

test("conflicts after a partial history update retain the journal and block subsequent decisions", async (t) => {
	const paths = await createToolWorkspace(t, "review-decision-conflict-");
	const a = await proposal(paths, { "a.md": "after a" });
	const b = await proposal(paths, { "b.md": "after b" });
	await assert.rejects(
		acceptReviewProposals(paths, [a.id, b.id], {
			onCheckpoint: async (event) => {
				if (event === "decision") await writeFile(join(paths.memoryDir, "b.md"), "external");
			},
		}),
		/Recovery conflict/,
	);
	assert.equal((await readReviewProposal(paths, a.id)).status, "accepted");
	assert.equal((await readReviewProposal(paths, b.id)).status, "pending");
	await assert.rejects(recoverReviewStore(paths), /Recovery conflict/);
	await assert.rejects(rejectReviewProposal(paths, b.id), /recovery first/);
	assert.equal(await readFile(join(paths.memoryDir, "b.md"), "utf8"), "external");
});

test("an external revert after write but before progress is never replayed", async (t) => {
	const paths = await createToolWorkspace(t, "review-unmarked-revert-");
	await writeFile(join(paths.memoryDir, "fact.md"), "before");
	const stored = await proposal(paths, { "fact.md": "after" });
	await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("write")), /injected/);
	await writeFile(join(paths.memoryDir, "fact.md"), "before");
	await assert.rejects(recoverReviewStore(paths), /ambiguous write intent/);
	assert.equal(await readFile(join(paths.memoryDir, "fact.md"), "utf8"), "before");
	assert.equal((await readReviewProposal(paths, stored.id)).status, "pending");
});

test("interruption after intent but before write fails closed rather than guessing", async (t) => {
	const paths = await createToolWorkspace(t, "review-before-write-");
	const stored = await proposal(paths, { "fact.md": "after" });
	await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("intent")), /injected/);
	await assert.rejects(recoverReviewStore(paths), /ambiguous write intent/);
	assert.deepEqual(await readdir(paths.memoryDir), []);
	assert.equal((await readReviewProposal(paths, stored.id)).status, "pending");
});

test("non-private existing store directories are refused, not silently reused", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX permission bits only");
	const paths = await createToolWorkspace(t, "review-private-");
	const store = reviewStoreDirectory(paths);
	await mkdir(store, { mode: 0o700 });
	await chmod(store, 0o755);
	await assert.rejects(prepareReviewWorkspace(paths), /must be private/);
	await chmod(store, 0o700);
	await prepareReviewWorkspace(paths);
});

test("recovery preserves recognized active progress while visiting earlier group members", async (t) => {
	const paths = await createToolWorkspace(t, "review-recover-active-");
	await writeFile(join(paths.memoryDir, "a.md"), "before a");
	await writeFile(join(paths.memoryDir, "z.md"), "before z");
	const stored = await proposal(paths, { "a.md": "after a", "z.md": "after z" });
	await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("write", 2)), /injected/);
	await assert.rejects(
		recoverReviewStore(paths, {
			onCheckpoint: async (event, path) => {
				if (event === "progress" && path === "a.md") await writeFile(join(paths.memoryDir, "z.md"), "before z");
			},
		}),
		/Recovery conflict/,
	);
	assert.equal(await readFile(join(paths.memoryDir, "z.md"), "utf8"), "before z");
	await assert.rejects(recoverReviewStore(paths), /Recovery conflict/);
});

test("unstarted journal members cannot acquire attribution from identical external writes", async (t) => {
	const paths = await createToolWorkspace(t, "review-unstarted-");
	const stored = await proposal(paths, { "fact.md": "after" });
	await assert.rejects(acceptReviewProposals(paths, [stored.id], interrupt("journal")), /injected/);
	await writeFile(join(paths.memoryDir, "fact.md"), "after");
	await assert.rejects(recoverReviewStore(paths), /Recovery conflict/);
	assert.equal((await readReviewProposal(paths, stored.id)).status, "pending");
	assert.equal(await readFile(join(paths.memoryDir, "fact.md"), "utf8"), "after");
});
