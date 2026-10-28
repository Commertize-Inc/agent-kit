// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-1 item 1: availableTools on every event line, event filters, terminal exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommertizeClient } from "../src/index.ts";
import { availableTools, EVENT_SCHEMA, EVENT_TYPES, listen, matchesFilter, type KitEvent } from "../src/events.ts";
import { EXIT } from "../src/handback.ts";
import { main } from "../src/cli.ts";

const ENV = { baseUrl: "https://api.commertize.com" };
const T = (id: string, status: string) => ({ task_id: id, status, task_class: "c1" });

function board(seq: (unknown[] | string)[]) {
	let i = 0;
	return (async () => {
		const s = seq[Math.min(i++, seq.length - 1)]!;
		if (typeof s === "string") return new Response("{}", { status: Number(s.slice(4)) });
		return new Response(JSON.stringify({ tasks: s }), { status: 200 });
	}) as typeof fetch;
}

async function run(argv: string[], seq: (unknown[] | string)[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main(argv, (l) => out.push(l), (l) => err.push(l), {
		client: () => new CommertizeClient(ENV, board(seq)),
		sleep: async () => {},
		maxPolls: seq.length,
		signals: false,
	});
	return { code, out, err, lines: out.map((l) => JSON.parse(l)) };
}

// --- availableTools ----------------------------------------------------------

test("availableTools: an open task can be watched; a final or removed task only has a history", () => {
	assert.deepEqual(availableTools("work.task.opened", { task_id: "a", status: "open" }), ["job watch", "job history"]);
	assert.deepEqual(availableTools("work.task.changed", { task_id: "a", status: "submitted" }), ["job watch", "job history"]);
	for (const s of ["completed", "rejected", "expired", "closed", "cancelled"])
		assert.deepEqual(availableTools("work.task.changed", { task_id: "a", status: s }), ["job history"], s);
	assert.deepEqual(availableTools("work.task.removed", { task_id: "a" }), ["job history"]);
	// a prototype key is not a final state
	assert.deepEqual(availableTools("work.task.changed", { task_id: "a", status: "toString" }), ["job watch", "job history"]);
});

test("availableTools: snapshot is the union over its tasks; empty board offers no task command", () => {
	assert.deepEqual(availableTools("work.board.snapshot", { tasks: [T("a", "completed")] }), ["job history"]);
	assert.deepEqual(availableTools("work.board.snapshot", { tasks: [T("a", "completed"), T("b", "open")] }), ["job watch", "job history"]);
	assert.deepEqual(availableTools("work.board.snapshot", { tasks: [] }), []);
});

test("availableTools: stream lines", () => {
	assert.deepEqual(availableTools("stream.started", {}), ["routes"]);
	assert.deepEqual(availableTools("stream.error", {}), ["routes"]);
	assert.deepEqual(availableTools("stream.stopped", { reason: "route_missing" }), ["routes"]);
	assert.deepEqual(availableTools("stream.stopped", { reason: "max_polls" }), ["events listen", "job history"]);
	for (const t of EVENT_TYPES) assert.ok(Array.isArray(availableTools(t, {})), t);
});

test("availableTools: every line events listen --json prints carries it, and every name is a real kit command", async () => {
	const r = await run(["events", "listen", "--json"], [[T("a", "open")], "err:503", [T("a", "completed"), T("b", "open")], [T("b", "open")]]);
	assert.equal(r.code, 0);
	const events = r.lines.filter((l) => l.schema === EVENT_SCHEMA);
	assert.ok(events.length >= 6);
	const real = new Set(["routes", "events listen", "job watch", "job history"]);
	for (const e of events) {
		assert.ok(Array.isArray(e.availableTools), JSON.stringify(e));
		for (const c of e.availableTools) assert.ok(real.has(c), c);
		assert.deepEqual(e.availableTools, availableTools(e.type, e.data));
	}
	// terminal lines carry a hand_back; non-terminal lines do not
	const done = events.find((e) => e.type === "work.task.changed" && e.data.status === "completed")!;
	assert.equal(done.hand_back.reason, "task_completed");
	assert.equal(events.find((e) => e.type === "work.task.removed")!.hand_back.reason, "task_removed");
	assert.equal(events.at(-1)!.type, "stream.stopped");
	assert.equal(events.at(-1)!.hand_back.reason, "stream_stopped");
	assert.equal(events.find((e) => e.type === "work.task.opened")!.hand_back, undefined);
});

// --- filters -------------------------------------------------------------------

const ev = (seq: number, type: string, data: object, ts = "2026-10-28T10:00:00.000Z"): KitEvent =>
	({ schema: EVENT_SCHEMA, seq, ts, type, data, availableTools: [] }) as unknown as KitEvent;

test("matchesFilter: --type exact, --since inclusive, --job by task id or snapshot membership; errors and stop always pass", () => {
	const f = { types: new Set(["work.task.changed"]) };
	assert.equal(matchesFilter(ev(1, "work.task.changed", { task_id: "a" }), f), true);
	assert.equal(matchesFilter(ev(1, "work.task.opened", { task_id: "a" }), f), false);
	assert.equal(matchesFilter(ev(1, "stream.error", {}), f), true);
	assert.equal(matchesFilter(ev(1, "stream.stopped", {}), f), true);
	assert.equal(matchesFilter(ev(1, "stream.started", {}), f), false);
	const since = { sinceMs: Date.parse("2026-10-28T10:00:00Z") };
	assert.equal(matchesFilter(ev(1, "work.task.opened", {}, "2026-10-28T10:00:00.000Z"), since), true, "inclusive at the boundary");
	assert.equal(matchesFilter(ev(1, "work.task.opened", {}, "2026-10-28T09:59:59.999Z"), since), false);
	assert.equal(matchesFilter(ev(1, "work.task.opened", {}, "garbage"), since), false, "an unparseable ts does not pass");
	const job = { job: "a" };
	assert.equal(matchesFilter(ev(1, "work.task.changed", { task_id: "a" }), job), true);
	assert.equal(matchesFilter(ev(1, "work.task.changed", { task_id: "b" }), job), false);
	assert.equal(matchesFilter(ev(1, "work.board.snapshot", { tasks: [T("b", "open"), T("a", "open")] }), job), true);
	assert.equal(matchesFilter(ev(1, "work.board.snapshot", { tasks: [T("b", "open")] }), job), false);
	assert.equal(matchesFilter(ev(1, "work.task.changed", { task_id: "b" }), undefined), true);
});

test("events listen: --type and --job filter the printed lines; stream.stopped still printed", async () => {
	const r = await run(["events", "listen", "--json", "--type", "work.task.changed"], [[T("a", "open"), T("b", "open")], [T("a", "submitted"), T("b", "open"), T("c", "open")]]);
	const types = r.lines.filter((l) => l.schema === EVENT_SCHEMA).map((l) => l.type);
	assert.deepEqual(types, ["work.task.changed", "stream.stopped"]);
	const j = await run(["events", "listen", "--json", "--job", "b"], [[T("a", "open"), T("b", "open")], [T("a", "completed"), T("b", "submitted")], [T("b", "completed")]]);
	const evs = j.lines.filter((l) => l.schema === EVENT_SCHEMA);
	assert.ok(evs.every((e) => e.type.startsWith("stream.") || e.data.task_id === "b" || e.data.tasks?.every((t: { task_id: string }) => t.task_id === "b")));
	assert.ok(evs.some((e) => e.type === "work.task.changed" && e.data.status === "completed"));
	// --job on listen does not stop the stream (that is job watch)
	assert.equal(j.lines.at(-1).data.reason, "max_polls");
});

test("filters: an unknown --type, a bad --since or a bad --job is a usage error, nothing sent", async () => {
	for (const argv of [
		["events", "listen", "--type", "work.task.*"],
		["events", "listen", "--since", "yesterday"],
		["events", "listen", "--since", "2026-13-45T00:00:00Z"],
		["events", "listen", "--job", "a b"],
		["job", "watch", "a", "--type", "work.task.changed"],
	]) {
		let called = 0;
		const code = await main([...argv, "--json"], () => {}, () => {}, {
			client: () => new CommertizeClient(ENV, (async () => (called++, new Response("{}"))) as typeof fetch),
			signals: false,
			sleep: async () => {},
			maxPolls: 1,
		});
		assert.equal(code, EXIT.usage, argv.join(" "));
		assert.equal(called, 0);
	}
});

// --- job watch terminal exit codes ---------------------------------------------

test("job watch: each final state has its own exit code and hand_back; leaving the board is 14; --once on an open task is 5", async () => {
	const cases: [string, number, string][] = [
		["completed", 0, "task_completed"],
		["rejected", 10, "task_rejected"],
		["expired", 11, "task_expired"],
		["cancelled", 12, "task_cancelled"],
		["closed", 13, "task_closed"],
	];
	for (const [status, exit, reason] of cases) {
		// reached during the watch
		const a = await run(["job", "watch", "a", "--json"], [[T("a", "open")], [T("a", status)]]);
		assert.equal(a.code, exit, `changed to ${status}`);
		assert.equal(a.lines.at(-1).hand_back.reason, reason);
		assert.equal(a.lines.at(-1).exit_code, exit);
		// already final on the first read
		const b = await run(["job", "watch", "a", "--json"], [[T("a", status)]]);
		assert.equal(b.code, exit, `already ${status}`);
		assert.equal(b.lines.at(-1).data.final.status, status);
	}
	const gone = await run(["job", "watch", "a", "--json"], [[T("a", "open")], []]);
	assert.equal(gone.code, 14);
	assert.equal(gone.lines.at(-1).hand_back.reason, "task_removed");
	const open = await run(["job", "watch", "a", "--once", "--json"], [[T("a", "open")]]);
	assert.equal(open.code, 5);
	assert.match(open.lines.at(-1).next_step, /job watch a/);
});

test("exit codes: one table, no value used twice", () => {
	const vals = Object.values(EXIT);
	assert.equal(new Set(vals).size, vals.length);
	assert.deepEqual(
		{ ok: EXIT.ok, usage: EXIT.usage, not_open: EXIT.not_open, pending: EXIT.pending, busy: EXIT.busy, drift: EXIT.skill_drift, not_found: EXIT.not_found },
		{ ok: 0, usage: 2, not_open: 4, pending: 5, busy: 9, drift: 15, not_found: 16 }
	);
});

test("listen: the outcome names the final state a watch stopped on", async () => {
	const { watchStop } = await import("../src/events.ts");
	const o = await listen({ client: new CommertizeClient(ENV, board([[T("a", "open")], [T("a", "rejected")]])), emit: () => {}, sleep: async () => {}, taskId: "a", stopWhen: watchStop("a"), maxPolls: 5 });
	assert.deepEqual(o.final, { task_id: "a", status: "rejected" });
});
