// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// Split sign-in: `auth start` exits fast with the URL; `auth complete --wait` polls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CommertizeClient, ROUTES, type Route } from "../src/index.ts";
import { authStart, authComplete, AUTH_EXIT } from "../src/auth.ts";
import { main } from "../src/cli.ts";
import { fakeFetch } from "./helpers.ts";

const ENV = { baseUrl: "https://api.commertize.com" };
const RID = "req_ABCdef123456";

/** The routes table with the two pairing rows switched live, as they will be once the API ships them. */
function liveRoutes(): Record<string, Route> {
	const t: Record<string, Route> = {};
	for (const [k, v] of Object.entries(ROUTES)) t[k] = { ...v } as Route;
	t.pairingStart = { ...t.pairingStart!, status: "live" };
	t.pairingStatus = { ...t.pairingStatus!, status: "live" };
	return t;
}

const START_OK = { requestId: RID, signinUrl: "https://commertize.com/agents/pair?r=" + RID, expiresIn: 600 };

test("auth routes: pairingStatus is in the table, and both pairing rows are still missing today", () => {
	assert.equal(ROUTES.pairingStart.status, "missing");
	assert.equal(ROUTES.pairingStatus.status, "missing");
	assert.equal(ROUTES.pairingStatus.path, "/agents/v1/pairings/:requestId");
});

test("auth start: today it stops before any network call with route_missing (exit 4)", async () => {
	const { f, calls } = fakeFetch({});
	const out: string[] = [];
	const code = await main(["auth", "start", "--json"], (l) => out.push(l), () => {}, { client: () => new CommertizeClient(ENV, f) });
	assert.equal(code, 4);
	const o = JSON.parse(out[0]!);
	assert.equal(o.error.code, "route_missing");
	assert.ok(o.next_step);
	assert.equal(calls.length, 0);
});

test("auth start: returns signinUrl, requestId and expiresIn and makes exactly one call", async () => {
	const { f, calls } = fakeFetch({ "POST /agents/v1/pairings": { status: 201, body: START_OK } });
	const r = await authStart(new CommertizeClient(ENV, f, liveRoutes()));
	assert.deepEqual(r, { requestId: RID, signinUrl: START_OK.signinUrl, expiresIn: 600 });
	assert.equal(calls.length, 1);
});

test("auth start: a sign-in URL off the Commertize sign-in hosts is refused (lookalikes, http, userinfo, port)", async () => {
	for (const url of [
		"https://commertize.co/pair",
		"https://commertize.com.evil.test/pair",
		"http://commertize.com/pair",
		"https://user@commertize.com/pair",
		"https://commertize.com:8443/pair",
		"https://evil.test/?u=https://commertize.com",
		"https://xn--commrtize-b1a.com/pair",
		"https://commertize.com./pair",
		"javascript:alert(1)//commertize.com",
	]) {
		const { f } = fakeFetch({ "POST /agents/v1/pairings": { status: 201, body: { ...START_OK, signinUrl: url } } });
		await assert.rejects(() => authStart(new CommertizeClient(ENV, f, liveRoutes())), /sign-in URL/, url);
	}
});

test("auth start: a request id that could steer the status path is refused", async () => {
	for (const id of ["../../admin", "a/b", "short", "x".repeat(200), "id?x=1", "id%2f"]) {
		const { f } = fakeFetch({ "POST /agents/v1/pairings": { status: 201, body: { ...START_OK, requestId: id } } });
		await assert.rejects(() => authStart(new CommertizeClient(ENV, f, liveRoutes())), /request id/, id);
	}
	for (const e of [0, -1, 1e9, "600", null]) {
		const { f } = fakeFetch({ "POST /agents/v1/pairings": { status: 201, body: { ...START_OK, expiresIn: e } } });
		await assert.rejects(() => authStart(new CommertizeClient(ENV, f, liveRoutes())), /expiresIn/, String(e));
	}
});

test("auth start --json via main: exit 0, data has the URL, next_step is the complete command", async () => {
	const { f } = fakeFetch({ "POST /agents/v1/pairings": { status: 201, body: START_OK } });
	const out: string[] = [];
	const code = await main(["auth", "start", "--no-wait", "--json"], (l) => out.push(l), () => {}, {
		client: () => new CommertizeClient(ENV, f, liveRoutes()),
	});
	assert.equal(code, 0);
	const o = JSON.parse(out[0]!);
	assert.equal(o.data.signinUrl, START_OK.signinUrl);
	assert.equal(o.next_step, `commertize-agent auth complete --request ${RID} --wait --json`);
});

function statusFetch(seq: unknown[]) {
	let i = 0;
	const calls: string[] = [];
	const f = (async (input: unknown) => {
		calls.push(String(input));
		const body = seq[Math.min(i++, seq.length - 1)];
		return new Response(JSON.stringify(body), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

test("auth complete --no-wait: one status call; pending is exit 5 with a --wait next_step", async () => {
	const { f, calls } = statusFetch([{ status: "pending" }]);
	const r = await authComplete(new CommertizeClient(ENV, f, liveRoutes()), RID, { wait: false });
	assert.equal(r.status, "pending");
	assert.equal(calls.length, 1);
	assert.match(calls[0]!, new RegExp(`/agents/v1/pairings/${RID}$`));
	assert.equal(AUTH_EXIT.pending, 5);
});

test("auth complete --wait: polls until approved; the credential goes to the sink and never into the result", async () => {
	const { f, calls } = statusFetch([{ status: "pending" }, { status: "pending" }, { status: "approved", sessionToken: "TOKEN-xyz" }]);
	const slept: number[] = [];
	const got: string[] = [];
	const r = await authComplete(new CommertizeClient(ENV, f, liveRoutes()), RID, {
		wait: true,
		intervalMs: 2000,
		timeoutMs: 60_000,
		sleep: async (ms) => void slept.push(ms),
		onCredential: async (t) => (got.push(t), { stored: true, where: "keychain" }),
	});
	assert.equal(r.status, "approved");
	assert.equal(calls.length, 3);
	assert.deepEqual(slept, [2000, 2000]);
	assert.deepEqual(got, ["TOKEN-xyz"]);
	assert.doesNotMatch(JSON.stringify(r), /TOKEN-xyz/);
	assert.equal(r.credential, "stored");
});

test("auth complete: approved with no sink reports not_stored and does not leak the token", async () => {
	const { f } = statusFetch([{ status: "approved", sessionToken: "TOKEN-abc" }]);
	const out: string[] = [];
	const err: string[] = [];
	const code = await main(["auth", "complete", "--request", RID, "--json"], (l) => out.push(l), (l) => err.push(l), {
		client: () => new CommertizeClient(ENV, f, liveRoutes()),
		credentialSink: undefined,
	});
	assert.doesNotMatch(out.join("") + err.join(""), /TOKEN-abc/);
	const o = JSON.parse(out[0]!);
	assert.equal(o.data.status, "approved");
	assert.equal(o.data.credential, "not_stored");
	assert.equal(code, 0);
	assert.match(o.next_step, /configure/);
});

test("auth complete --wait: stops at the timeout (exit 8), on denied (6) and on expired (7)", async () => {
	let t = 0;
	const pend = statusFetch([{ status: "pending" }]);
	const r = await authComplete(new CommertizeClient(ENV, pend.f, liveRoutes()), RID, {
		wait: true,
		intervalMs: 5000,
		timeoutMs: 12_000,
		now: () => t,
		sleep: async (ms) => void (t += ms),
	});
	assert.equal(r.status, "timeout");
	assert.ok(pend.calls.length >= 2 && pend.calls.length <= 4, String(pend.calls.length));
	for (const [s, code] of [["denied", 6], ["expired", 7]] as const) {
		const { f } = statusFetch([{ status: s }]);
		const out: string[] = [];
		assert.equal(
			await main(["auth", "complete", "--request", RID, "--wait", "--json"], (l) => out.push(l), () => {}, {
				client: () => new CommertizeClient(ENV, f, liveRoutes()),
			}),
			code
		);
		assert.equal(JSON.parse(out[0]!).data.status, s);
	}
	assert.equal(AUTH_EXIT.timeout, 8);
});

test("auth complete: an unknown server status fails closed (not treated as approved)", async () => {
	const { f } = statusFetch([{ status: "APPROVED " }]);
	await assert.rejects(() => authComplete(new CommertizeClient(ENV, f, liveRoutes()), RID, { wait: false }), /status/);
	const { f: f2 } = statusFetch([{ status: "approved" }]);
	const r = await authComplete(new CommertizeClient(ENV, f2, liveRoutes()), RID, { wait: false });
	assert.equal(r.credential, "none");
});

test("auth complete: a bad --request is a usage error before any call; interval has a floor", async () => {
	const { f, calls } = fakeFetch({});
	const out: string[] = [];
	assert.equal(await main(["auth", "complete", "--request", "../x", "--json"], (l) => out.push(l), () => {}, { client: () => new CommertizeClient(ENV, f, liveRoutes()) }), 2);
	assert.equal(calls.length, 0);
	const { f: f3 } = statusFetch([{ status: "pending" }, { status: "approved" }]);
	const slept: number[] = [];
	await authComplete(new CommertizeClient(ENV, f3, liveRoutes()), RID, { wait: true, intervalMs: 1, sleep: async (ms) => void slept.push(ms) });
	assert.ok(slept[0]! >= 2000, "poll interval floor is 2 s");
	assert.equal(await main(["auth", "complete", "--json"], () => {}, () => {}), 2);
	assert.equal(await main(["auth", "nope", "--json"], () => {}, () => {}), 2);
});

test("register --no-wait with no session token starts sign-in instead of failing", async () => {
	const { f, calls } = fakeFetch({ "POST /agents/v1/pairings": { status: 201, body: START_OK } });
	const out: string[] = [];
	const code = await main(["register", "--agent-address", "0x" + "d".repeat(40), "--no-wait", "--json"], (l) => out.push(l), () => {}, {
		client: () => new CommertizeClient(ENV, f, liveRoutes()),
	});
	assert.equal(code, AUTH_EXIT.pending);
	const o = JSON.parse(out[0]!);
	assert.equal(o.data.signinUrl, START_OK.signinUrl);
	assert.match(o.next_step, /auth complete --request/);
	assert.equal(calls.length, 1);
	assert.equal(new URL(calls[0]!.url).pathname, "/agents/v1/pairings");
});
