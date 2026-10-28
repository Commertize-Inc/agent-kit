// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-1b: events drain (read-and-ack in one step; --key makes a retry safe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_SCHEMA, type KitEvent } from "../src/events.ts";
import { cursorPath, drain, DrainBusyError, DrainSourceChangedError } from "../src/drain.ts";
import { EXIT } from "../src/handback.ts";
import { main } from "../src/cli.ts";

const T = (id: string, status: string) => ({ task_id: id, status, task_class: "c1" });
const ev = (seq: number, type: string, data: object, ts = "2026-10-28T10:00:00.000Z"): KitEvent =>
	({ schema: EVENT_SCHEMA, seq, ts, type, data, availableTools: [] }) as unknown as KitEvent;

function file(lines: (object | string)[], trailingNewline = true) {
	const dir = mkdtempSync(join(tmpdir(), "kit-drain-"));
	const f = join(dir, "events.ndjson");
	writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (trailingNewline ? "\n" : ""));
	return f;
}
const E = (seq: number, type = "work.task.opened", task = `t${seq}`) => ev(seq, type, { task_id: task, status: "open" });

test("drain: takes a batch, acks it, and the next drain gets the next batch; nothing returned twice", () => {
	const f = file([E(1), E(2), E(3), E(4), E(5)]);
	const a = drain({ file: f, limit: 2 });
	assert.deepEqual(a.events.map((e) => e.seq), [1, 2]);
	assert.equal(a.more, true);
	const b = drain({ file: f, limit: 2 });
	assert.deepEqual(b.events.map((e) => e.seq), [3, 4]);
	const c = drain({ file: f, limit: 2 });
	assert.deepEqual(c.events.map((e) => e.seq), [5]);
	assert.equal(c.more, false);
	const d = drain({ file: f, limit: 2 });
	assert.deepEqual(d.events, []);
	assert.equal(d.offset, readFileSync(f).length);
	assert.notEqual(a.batch_id, b.batch_id);
	// appended lines are picked up later
	appendFileSync(f, JSON.stringify(E(6)) + "\n");
	assert.deepEqual(drain({ file: f }).events.map((e) => e.seq), [6]);
});

test("drain: an unfinished last line is never taken, and is taken once finished", () => {
	const f = file([E(1), JSON.stringify(E(2)).slice(0, 20)], false);
	assert.deepEqual(drain({ file: f }).events.map((e) => e.seq), [1]);
	assert.deepEqual(drain({ file: f }).events, []);
	writeFileSync(f, JSON.stringify(E(1)) + "\n" + JSON.stringify(E(2)) + "\n");
	assert.deepEqual(drain({ file: f }).events.map((e) => e.seq), [2]);
});

test("drain: junk lines are counted and acked; filtered events are acked; the cursor is per consumer", () => {
	const f = file([E(1), "not json", JSON.stringify({ schema: "other" }), E(2, "work.task.changed"), E(3)]);
	const a = drain({ file: f, filter: { types: new Set(["work.task.changed"]) }, consumer: "changes" });
	assert.deepEqual(a.events.map((e) => e.seq), [2]);
	assert.equal(a.skipped, 2);
	assert.equal(a.filtered, 2);
	// another consumer starts from 0 and sees everything
	const b = drain({ file: f, consumer: "all" });
	assert.deepEqual(b.events.map((e) => e.seq), [1, 2, 3]);
	assert.ok(existsSync(cursorPath(f, "changes")) && existsSync(cursorPath(f, "all")));
	assert.throws(() => drain({ file: f, consumer: "../x" }), /consumer/);
});

test("drain --key: a retry with the same key returns the same batch and moves nothing; a new key moves on", () => {
	const f = file([E(1), E(2), E(3), E(4)]);
	const a = drain({ file: f, limit: 2, key: "k1" });
	const again = drain({ file: f, limit: 2, key: "k1" });
	assert.equal(again.redelivered, true);
	assert.equal(again.batch_id, a.batch_id);
	assert.deepEqual(again.events, a.events);
	assert.equal(again.offset, a.offset);
	const third = drain({ file: f, limit: 2, key: "k1" });
	assert.deepEqual(third.events, a.events, "idempotent however many times");
	const b = drain({ file: f, limit: 2, key: "k2" });
	assert.deepEqual(b.events.map((e) => e.seq), [3, 4]);
	assert.equal(b.redelivered, false);
	// the old key is forgotten once a new batch was taken
	assert.deepEqual(drain({ file: f, limit: 2, key: "k1" }).events, []);
	// same key with a different shape is refused rather than guessed
	const g = file([E(1), E(2)]);
	drain({ file: g, limit: 1, key: "z" });
	assert.throws(() => drain({ file: g, limit: 2, key: "z" }), /different/);
});

test("drain: a live lock holder makes a second drain busy (exit 9); a dead holder's lock is taken over", async () => {
	const f = file([E(1)]);
	const lockFile = `${cursorPath(f, "default")}.lock`;
	writeFileSync(lockFile, String(process.pid)); // this process is alive
	assert.throws(() => drain({ file: f }), DrainBusyError);
	const out: string[] = [];
	assert.equal(await main(["events", "drain", "--file", f, "--json"], (l) => out.push(l), () => {}), EXIT.busy);
	assert.equal(JSON.parse(out[0]!).hand_back.reason, "busy");
	assert.equal(readFileSync(lockFile, "utf8"), String(process.pid), "a held lock is left alone");
	writeFileSync(lockFile, "99999999"); // no such process
	assert.deepEqual(drain({ file: f }).events.map((e) => e.seq), [1]);
	assert.equal(existsSync(lockFile), false, "lock released");
});

test("drain: a truncated or replaced file is refused, never re-read from a guessed offset", () => {
	const f = file([E(1), E(2)]);
	drain({ file: f });
	truncateSync(f, 5);
	assert.throws(() => drain({ file: f }), DrainSourceChangedError);
	const g = file([E(1), E(2)]);
	drain({ file: g });
	const h = g + ".new";
	writeFileSync(h, JSON.stringify(E(9)) + "\n" + JSON.stringify(E(8)) + "\n".repeat(400));
	renameSync(h, g);
	assert.throws(() => drain({ file: g }), DrainSourceChangedError);
});

test("drain: offsets are bytes, so invalid UTF-8 and multi-byte text do not shift them", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-drain-bytes-"));
	const f = join(dir, "e.ndjson");
	const one = Buffer.from(JSON.stringify(ev(1, "work.task.opened", { task_id: "é€😀", status: "open" })) + "\n");
	writeFileSync(f, Buffer.concat([one, Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(JSON.stringify(E(2)) + "\n")]));
	const a = drain({ file: f, limit: 1 });
	assert.equal(a.offset, one.length);
	const b = drain({ file: f });
	assert.deepEqual(b.events.map((e) => e.seq), [2]);
	assert.equal(b.skipped, 1);
});

test("events drain via the CLI: JSON result; usage errors for missing --file and bad --limit", async () => {
	const f = file([E(1), E(2), E(3)]);
	const out: string[] = [];
	assert.equal(await main(["events", "drain", "--file", f, "--limit", "2", "--key", "a", "--json"], (l) => out.push(l), () => {}), 0);
	const o = JSON.parse(out[0]!);
	assert.deepEqual(o.data.events.map((e: KitEvent) => e.seq), [1, 2]);
	assert.equal(o.data.more, true);
	for (const argv of [["events", "drain"], ["events", "drain", "--file", f, "--limit", "0"], ["events", "drain", "--file", f, "--limit", "1001"], ["events", "drain", "--file", f, "--key", "a b"]])
		assert.equal(await main([...argv, "--json"], () => {}, () => {}), EXIT.usage, argv.join(" "));
});

// --- round 3 (audit LOW-1..LOW-4) -------------------------------------------------

test("drain: a symlink planted at the old predictable temp path is never written through; the cursor stays a regular file", async () => {
	const { lstatSync, symlinkSync } = await import("node:fs");
	const f = file([E(1), E(2)]);
	const victim = join(mkdtempSync(join(tmpdir(), "kit-victim-")), "victim.txt");
	writeFileSync(victim, "untouched\n");
	symlinkSync(victim, `${cursorPath(f, "default")}.tmp-${process.pid}`);
	assert.deepEqual(drain({ file: f }).events.map((e) => e.seq), [1, 2]);
	assert.equal(readFileSync(victim, "utf8"), "untouched\n");
	assert.equal(lstatSync(cursorPath(f, "default")).isSymbolicLink(), false);
	assert.equal(JSON.parse(readFileSync(cursorPath(f, "default"), "utf8")).offset, readFileSync(f).length);
});

test("drain: a FIFO --file is refused at once (usage, exit 2), never opened", async () => {
	const { spawnSync } = await import("node:child_process");
	const fifo = join(mkdtempSync(join(tmpdir(), "kit-fifo-")), "events.ndjson");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	assert.throws(() => drain({ file: fifo }), /not a regular file/);
	const out: string[] = [];
	assert.equal(await main(["events", "drain", "--file", fifo, "--json"], (l) => out.push(l), () => {}), EXIT.usage);
	assert.equal(JSON.parse(out[0]!).hand_back.reason, "usage");
});

test("drain: one drain reads at most 8 MiB past the cursor; the rest waits for the next drain", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-drain-cap-"));
	const f = join(dir, "e.ndjson");
	const junk = "x".repeat(1023) + "\n"; // 1 KiB lines that are not kit events
	writeFileSync(f, junk.repeat(9 * 1024) + JSON.stringify(E(1)) + "\n");
	const a = drain({ file: f });
	assert.deepEqual(a.events, [], "the event past the 8 MiB window is not reached in one drain");
	assert.ok(a.offset <= 8 * 1024 * 1024, `offset ${a.offset}`);
	assert.equal(a.more, true);
	const b = drain({ file: f });
	assert.deepEqual(b.events.map((e) => e.seq), [1]);
});

test("drain: a single line longer than 8 MiB is refused, not taken", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-drain-long-"));
	const f = join(dir, "e.ndjson");
	writeFileSync(f, "y".repeat(8 * 1024 * 1024 + 10) + "\n");
	assert.throws(() => drain({ file: f }), DrainSourceChangedError);
});

test("drain busy: next_step names the stale-lock recovery section", async () => {
	const f = file([E(1)]);
	writeFileSync(`${cursorPath(f, "default")}.lock`, String(process.pid));
	const out: string[] = [];
	assert.equal(await main(["events", "drain", "--file", f, "--json"], (l) => out.push(l), () => {}), EXIT.busy);
	assert.match(JSON.parse(out[0]!).next_step, /agent-loop\.md#a-lock-that-stays-busy/);
});
