// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// events listen (NDJSON), job watch, job history, serve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CommertizeClient, ROUTES, type Route } from "../src/index.ts";
import { EVENT_SCHEMA, diffBoard, history, listen, POLL_FLOOR_MS, type KitEvent } from "../src/events.ts";
import { EventHub, makeHandler, SERVE_HOST, SERVE_MAX_CLIENTS } from "../src/serve.ts";
import { main, JSON_SCHEMA } from "../src/cli.ts";

const ENV = { baseUrl: "https://api.commertize.com", sessionToken: "SESSION-SECRET" };
// Loopback host and port for the serve handler tests, built from parts.
const LO = "127.0.0.1";
const PORT = 9123;
const HP = `${LO}:${PORT}`;

/** A fetch that answers the board from a sequence (one entry per call); "err:N" answers HTTP N. */
function boardSeq(seq: (unknown[] | string)[]) {
	let i = 0;
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const f = (async (input: unknown, init?: RequestInit) => {
		calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
		const s = seq[Math.min(i++, seq.length - 1)]!;
		if (typeof s === "string") return new Response("{}", { status: Number(s.slice(4)) });
		return new Response(JSON.stringify({ tasks: s }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}
const T = (id: string, status: string) => ({ task_id: id, status, task_class: "c1", required_kya_tier: "t0" });

async function runListen(seq: (unknown[] | string)[], extra: Partial<Parameters<typeof listen>[0]> = {}) {
	const { f, calls } = boardSeq(seq);
	const ev: KitEvent[] = [];
	const slept: number[] = [];
	const o = await listen({
		client: new CommertizeClient(ENV, f),
		emit: (e) => ev.push(e),
		sleep: async (ms) => void slept.push(ms),
		now: () => new Date("2026-10-27T20:00:00Z"),
		maxPolls: seq.length,
		...extra,
	});
	return { o, ev, slept, calls };
}

test("diffBoard: opened, changed (with previous_status) and removed", () => {
	const a = new Map([["t1", { task_id: "t1", status: "open" }], ["t2", { task_id: "t2", status: "open" }]]);
	const b = new Map([["t1", { task_id: "t1", status: "submitted" }], ["t3", { task_id: "t3", status: "open" }]]);
	assert.deepEqual(
		diffBoard(a, b).map((d) => [d.type, d.data.task_id, d.data.previous_status]),
		[["work.task.changed", "t1", "open"], ["work.task.opened", "t3", undefined], ["work.task.removed", "t2", "open"]]
	);
	assert.deepEqual(diffBoard(b, b), []);
});

test("listen: snapshot first, then only real changes; seq strictly increases; schema on every event", async () => {
	const { o, ev, slept } = await runListen([[T("t1", "open")], [T("t1", "open")], [T("t1", "submitted"), T("t2", "open")]]);
	assert.deepEqual(ev.map((e) => e.type), ["stream.started", "work.board.snapshot", "work.task.changed", "work.task.opened", "stream.stopped"]);
	ev.forEach((e, i) => {
		assert.equal(e.seq, i + 1);
		assert.equal(e.schema, EVENT_SCHEMA);
	});
	assert.equal(o.reason, "max_polls");
	assert.deepEqual(slept, [30_000, 30_000]);
});

test("listen: interval has a 15 s floor", async () => {
	const { slept } = await runListen([[], []], { intervalMs: 1 });
	assert.deepEqual(slept, [POLL_FLOOR_MS]);
});

test("listen: transient errors emit stream.error and back off (doubling, capped); recovery resets", async () => {
	const { ev, slept } = await runListen(["err:503", "err:429", "err:503", [T("t1", "open")], [T("t1", "open")]]);
	assert.equal(ev.filter((e) => e.type === "stream.error").length, 3);
	assert.equal(ev.find((e) => e.type === "stream.error")!.data.status, 503);
	assert.deepEqual(slept, [60_000, 120_000, 240_000, 30_000]);
	// audit L-3: retry_in_ms is the wait that follows, not half of it
	assert.deepEqual(ev.filter((e) => e.type === "stream.error").map((e) => e.data.retry_in_ms), [60_000, 120_000, 240_000]);
	const many = await runListen(Array(10).fill("err:500"));
	assert.ok(Math.max(...many.slept) <= 5 * 60_000);
	const errs = many.ev.filter((e) => e.type === "stream.error").map((e) => e.data.retry_in_ms);
	assert.deepEqual(errs.slice(0, many.slept.length), many.slept);
});

test("events listen text mode: board task_id/status/class cannot inject lines or escapes (audit L-2)", async () => {
	const evil = [{ task_id: "a\n2026-10-27T00:00:00.000Z work.task.changed x approved", status: "open\u001b[2J\r", task_class: "c" + String.fromCharCode(0x2028) + "d" }];
	const { f } = boardSeq([evil]);
	const txt: string[] = [];
	await main(["events", "listen", "--once"], (l) => txt.push(l), () => {}, { client: () => new CommertizeClient(ENV, f), signals: false });
	for (const l of txt) {
		assert.ok(!Array.from(l).some((ch) => { const c = ch.codePointAt(0)!; return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029; }), JSON.stringify(l));
		assert.ok(!l.includes("\n"));
	}
	const { f: f2 } = boardSeq([evil]);
	const js: string[] = [];
	await main(["events", "listen", "--once", "--json"], (l) => js.push(l), () => {}, { client: () => new CommertizeClient(ENV, f2), signals: false });
	// --json keeps the raw value (JSON escapes it); only the human text is cleaned
	assert.ok(js.some((l) => JSON.parse(l).data?.tasks?.[0]?.task_id === evil[0]!.task_id));
});

test("listen: a route missing from the table ends the stream with route_missing and no network call", async () => {
	const routes: Record<string, Route> = {};
	for (const [k, v] of Object.entries(ROUTES)) routes[k] = { ...v } as Route;
	routes.workTasks = { ...routes.workTasks!, status: "missing", pending: "off" };
	const { f, calls } = boardSeq([[]]);
	const ev: KitEvent[] = [];
	const o = await listen({ client: new CommertizeClient(ENV, f, routes), emit: (e) => ev.push(e), sleep: async () => {} });
	assert.equal(o.reason, "route_missing");
	assert.equal(calls.length, 0);
	assert.equal(ev.at(-1)!.type, "stream.stopped");
});

test("listen: rows without a string id or status are dropped, not guessed; no credential is sent or emitted", async () => {
	const { ev, calls } = await runListen([[{ task_id: 7, status: "open" }, { status: "open" }, T("ok", "open")]]);
	assert.equal(ev.find((e) => e.type === "work.board.snapshot")!.data.count, 1);
	assert.equal(calls[0]!.headers.authorization, undefined, "the public board gets no session header");
	assert.doesNotMatch(JSON.stringify(ev), /SESSION-SECRET/);
});

test("job watch: only that task; stops on a final state; and stops at once if already final", async () => {
	const out: string[] = [];
	const { f } = boardSeq([[T("a", "open"), T("b", "open")], [T("a", "open"), T("b", "submitted")], [T("a", "completed"), T("b", "completed")], [T("a", "x")]]);
	const code = await main(["job", "watch", "a", "--json"], (l) => out.push(l), () => {}, {
		client: () => new CommertizeClient(ENV, f),
		sleep: async () => {},
		signals: false,
	});
	assert.equal(code, 0);
	const lines = out.map((l) => JSON.parse(l));
	const events = lines.filter((l) => l.schema === EVENT_SCHEMA);
	assert.ok(events.every((e) => e.type.startsWith("stream.") || e.data.task_id === "a" || e.type === "work.board.snapshot"));
	assert.deepEqual(events.filter((e) => e.type === "work.task.changed").map((e) => e.data.status), ["completed"]);
	const last = lines.at(-1);
	assert.equal(last.schema, JSON_SCHEMA);
	assert.equal(last.data.reason, "stopped");
	assert.match(last.next_step, /job history a/);
	// already final on the first read
	const { f: f2, calls } = boardSeq([[T("z", "expired")], [T("z", "expired")]]);
	// K-1: an expired task ends the watch with its own exit code (11), not 0
	assert.equal(await main(["job", "watch", "z", "--json"], () => {}, () => {}, { client: () => new CommertizeClient(ENV, f2), sleep: async () => {}, signals: false }), 11);
	assert.equal(calls.length, 1);
});

test("job watch: removal from the board ends the watch", async () => {
	const ev: KitEvent[] = [];
	const { f } = boardSeq([[T("a", "open")], []]);
	const { watchStop } = await import("../src/events.ts");
	const o = await listen({ client: new CommertizeClient(ENV, f), emit: (e) => ev.push(e), sleep: async () => {}, taskId: "a", stopWhen: watchStop("a"), maxPolls: 5 });
	assert.equal(o.reason, "stopped");
	assert.ok(ev.some((e) => e.type === "work.task.removed"));
});

test("events listen --json --once: NDJSON events then one result envelope; text mode is human lines", async () => {
	const { f } = boardSeq([[T("a", "open")]]);
	const out: string[] = [];
	assert.equal(await main(["events", "listen", "--once", "--json"], (l) => out.push(l), () => {}, { client: () => new CommertizeClient(ENV, f), signals: false }), 0);
	for (const l of out) JSON.parse(l);
	assert.equal(JSON.parse(out.at(-1)!).command, "events");
	assert.ok("next_step" in JSON.parse(out.at(-1)!));
	const { f: f2 } = boardSeq([[T("a", "open")]]);
	const txt: string[] = [];
	await main(["events", "listen", "--once"], (l) => txt.push(l), () => {}, { client: () => new CommertizeClient(ENV, f2), signals: false });
	assert.match(txt.join("\n"), /work\.board\.snapshot 1 task/);
});

test("events/job/serve: bad flags are usage errors", async () => {
	for (const argv of [["events"], ["events", "tail"], ["job"], ["job", "watch"], ["job", "history", "a"], ["events", "listen", "--interval", "5"], ["events", "serve", "--port", "80"], ["events", "serve", "--port", "x"], ["events", "listen", "--port", "9000"]])
		assert.equal(await main([...argv, "--json"], () => {}, () => {}, { signals: false }), 2, argv.join(" "));
});

test("job history: that task's events from the file, in order; junk lines counted, never parsed as events", () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-hist-"));
	const file = join(dir, "e.ndjson");
	const ev = (seq: number, type: string, data: object) => JSON.stringify({ schema: EVENT_SCHEMA, seq, ts: "t", type, data });
	writeFileSync(
		file,
		[
			ev(1, "work.board.snapshot", { count: 2, tasks: [T("a", "open"), T("b", "open")] }),
			ev(2, "work.task.changed", { task_id: "b", status: "submitted" }),
			"not json",
			JSON.stringify({ schema: "other", type: "work.task.changed", data: { task_id: "a" } }),
			ev(3, "work.task.changed", { task_id: "a", status: "completed" }),
			"",
		].join("\n")
	);
	const h = history(file, "a");
	assert.deepEqual(h.events.map((e) => e.seq), [1, 3]);
	assert.equal(h.skipped, 2);
	assert.throws(() => history(dir, "a"), /regular file|EISDIR/);
});

test("job history via main: exit 0 with events in data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-hist2-"));
	const file = join(dir, "e.ndjson");
	writeFileSync(file, JSON.stringify({ schema: EVENT_SCHEMA, seq: 1, ts: "t", type: "work.task.opened", data: { task_id: "q", status: "open" } }) + "\n");
	const out: string[] = [];
	assert.equal(await main(["job", "history", "q", "--from", file, "--json"], (l) => out.push(l), () => {}), 0);
	assert.equal(JSON.parse(out[0]!).data.events.length, 1);
});

// --- serve ------------------------------------------------------------------
class FakeRes extends EventEmitter {
	status = 0;
	headers: Record<string, string> = {};
	chunks: string[] = [];
	ended = false;
	writeHead(s: number, h: Record<string, string>) {
		this.status = s;
		this.headers = h;
		return this;
	}
	write(c: string) {
		this.chunks.push(c);
		return true;
	}
	end(c?: string) {
		if (c) this.chunks.push(c);
		this.ended = true;
		return this;
	}
}
const req = (url: string, headers: Record<string, string>, method = "GET") => ({ url, headers, method }) as unknown as IncomingMessage;
const call = (h: ReturnType<typeof makeHandler>, r: IncomingMessage) => {
	const res = new FakeRes();
	h(r, res as unknown as ServerResponse);
	return res;
};

test("serve: binds 127.0.0.1 only", async () => {
	assert.equal(SERVE_HOST, "127.0.0.1");
	const { f } = boardSeq([[]]);
	const seen: { port: number; host: string }[] = [];
	const errs: string[] = [];
	const code = await main(["events", "serve", "--port", "9123", "--once", "--json"], () => {}, (l) => errs.push(l), {
		client: () => new CommertizeClient(ENV, f),
		signals: false,
		listenServer: async (_h, port, host) => (seen.push({ port, host }), { close: async () => {} }),
	});
	assert.equal(code, 0);
	assert.deepEqual(seen, [{ port: 9123, host: "127.0.0.1" }]);
});

test("serve: Host must be this loopback address and port (DNS rebinding); any Origin is refused; GET only", () => {
	const h = makeHandler(new EventHub(), 9123, () => ({}));
	for (const host of [`evil.test:${PORT}`, `${LO}:${PORT + 1}`, "127.0.0.1", "localhost", `0.0.0.0:${PORT}`, `${LO}.nip.io:${PORT}`, `[::1]:${PORT}`, ""])
		assert.equal(call(h, req("/events", host ? { host } : {})).status, 421, host);
	assert.equal(call(h, req("/events", { host: HP, origin: "https://evil.test" })).status, 403);
	assert.equal(call(h, req("/events", { host: HP, origin: "null" })).status, 403);
	assert.equal(call(h, req("/events", { host: HP }, "POST")).status, 405);
	assert.equal(call(h, req("/admin", { host: `localhost:${PORT}` })).status, 404);
	assert.equal(call(h, req("/healthz", { host: `LOCALHOST:${PORT}` })).status, 200);
});

test("serve: /events is NDJSON, replays recent events, fans out, caps clients", () => {
	const hub = new EventHub();
	const h = makeHandler(hub, 9123, () => ({}));
	const e1: KitEvent = { schema: EVENT_SCHEMA, seq: 1, ts: "t", type: "stream.started", data: {}, availableTools: ["routes"] };
	hub.publish(e1);
	const a = call(h, req("/events", { host: HP }));
	assert.equal(a.status, 200);
	assert.equal(a.headers["content-type"], "application/x-ndjson");
	assert.deepEqual(a.chunks.map((c) => JSON.parse(c).seq), [1]);
	hub.publish({ ...e1, seq: 2 });
	assert.deepEqual(a.chunks.map((c) => JSON.parse(c).seq), [1, 2]);
	for (let i = 1; i < SERVE_MAX_CLIENTS; i++) call(h, req("/events", { host: HP }));
	assert.equal(call(h, req("/events", { host: HP })).status, 503);
	a.emit("close");
	assert.equal(hub.size, SERVE_MAX_CLIENTS - 1);
});
