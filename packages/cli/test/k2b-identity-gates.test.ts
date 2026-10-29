// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-2b: identity show (raw kya_state, /kya 404 is Not open), and the gated stubs:
// identity credential, register --name/--description/--homepage, agent update.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommertizeClient } from "../src/index.ts";
import { main, USAGE_TEXT } from "../src/cli.ts";
import { notOpen, KIT_DOCS } from "../src/handback.ts";
import { checkAgentText } from "../src/agenttext.ts";

const ENV = { baseUrl: "https://api.commertize.com", sessionToken: "SESSION-SECRET" };
const A1 = "0x" + "a".repeat(40);
const A2 = "0x" + "b".repeat(40);
const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const P2 = "aaaaaaaa-0000-4000-8000-000000000002";
const AGENTS = "/mandates/principal/agents";
const cp = (n: number) => String.fromCodePoint(n);
const CHECKS = `/kya/passports/${P1}/checks`;
const agent = (pid: string, addr: string, kyaStatus = "active", revokedAt: string | null = null) => ({ passportId: pid, agentAddress: addr, kyaStatus, createdAt: "2026-10-01T00:00:00.000Z", revokedAt, mandates: [] });
const page = (agents: object[]) => ({ nextCursor: null, principal_kyb_status: "unknown", principal_kyb_as_of: null, agents });

type Answer = { status?: number; body: unknown };
async function run(argv: string[], table: Record<string, Answer> = {}, json = true) {
	const calls: URL[] = [];
	let clients = 0;
	const f = (async (input: unknown) => {
		const u = new URL(String(input));
		calls.push(u);
		const hit = table[u.pathname];
		if (!hit) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
		return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
	}) as typeof fetch;
	const out: string[] = [];
	const err: string[] = [];
	const code = await main(json ? [...argv, "--json"] : argv, (l) => out.push(l), (l) => err.push(l), {
		client: () => {
			clients++;
			return new CommertizeClient(ENV, f);
		},
		home: mkdtempSync(join(tmpdir(), "kit-home-")),
		signals: false,
	});
	return { code, o: json ? JSON.parse(out.at(-1)!) : null, calls, clients, raw: out.join("\n") + "\n" + err.join("\n") };
}

test("NOT_OPEN is the reviewed string apx-b58b04e86a with the kit docs URL", () => {
	assert.equal(notOpen("identity credential"), `Not open: identity credential is not open on this network. See ${KIT_DOCS}.`);
});

// --- identity show ------------------------------------------------------------

test("identity show: kya_state is the raw served code; a revoked agent shows its date; the word verified never appears", async () => {
	for (const state of ["active", "revoked", "pending_review"]) {
		const t = { [AGENTS]: { body: page([agent(P1, A1, state, state === "revoked" ? "2026-10-20T00:00:00.000Z" : null), agent(P2, A2)]) }, [CHECKS]: { body: { checks: [] } } };
		for (const json of [true, false]) {
			const r = await run(["identity", "show", "--agent", P1], t, json);
			assert.equal(r.code, 0, state);
			assert.doesNotMatch(r.raw, /verif/i, "no 'verified' byte in stdout or stderr");
			if (json) {
				assert.equal(r.o.data.passport.kya_state, state);
				assert.equal("kyaStatus" in r.o.data.passport, false, "one key only: kya_state");
				assert.equal(r.o.data.passport.revokedAt, state === "revoked" ? "2026-10-20T00:00:00.000Z" : null);
			} else assert.match(r.raw, new RegExp(`kya_state ${state}`));
		}
	}
	const unknown = await run(["identity", "show", "--agent", "0x" + "c".repeat(40)], { [AGENTS]: { body: page([agent(P1, A1)]) } });
	assert.equal(unknown.code, 16);
	assert.equal(unknown.o.hand_back.reason, "agent_not_found");
});

test("identity show: a 404 from /kya is the Not open refusal, exit 4 route_not_open, never 'no checks'", async () => {
	for (const json of [true, false]) {
		const r = await run(["identity", "show", "--agent", P1], { [AGENTS]: { body: page([agent(P1, A1)]) } }, json);
		assert.equal(r.code, 4);
		assert.ok(r.raw.includes(notOpen("identity show")), "apx-b58b04e86a, exact");
		assert.doesNotMatch(r.raw, /KYA checks: 0|"checks":\s*\[\]/);
		if (json) {
			assert.equal(r.o.hand_back.reason, "route_not_open");
			assert.equal(r.o.error.code, "not_open");
			assert.equal(r.o.data.checks, null);
			assert.equal(r.o.data.passport.passportId, P1, "the passport read is still shown");
		}
	}
	const empty = await run(["identity", "show", "--agent", P1], { [AGENTS]: { body: page([agent(P1, A1)]) }, [CHECKS]: { body: { checks: [] } } });
	assert.equal(empty.code, 0, "an empty served list is a real answer");
	assert.deepEqual(empty.o.data.checks, []);
});

// --- gated stubs: refusal before any client or request -----------------------------

test("identity credential is Not open: exit 4, route_not_open, zero requests", async () => {
	for (const argv of [["identity", "credential"], ["identity", "credential", "--agent", P1], ["identity", "credential", "--agent", P1, "--verify"]]) {
		const r = await run(argv);
		assert.equal(r.code, 4, argv.join(" "));
		assert.equal(r.o.hand_back.reason, "route_not_open");
		assert.equal(r.o.error.message, notOpen("identity credential"));
		assert.equal(r.calls.length, 0);
		assert.equal(r.clients, 0, "no client is built");
	}
});

test("register --name / --description / --homepage: exit 4 before any request; plain register unchanged", async () => {
	for (const extra of [["--name", "Rex"], ["--description", "Books freight"], ["--homepage", "https://rex.example"], ["--name", "Rex", "--description", "d"]]) {
		const r = await run(["register", "--agent-address", A1, ...extra]);
		assert.equal(r.code, 4, extra.join(" "));
		assert.equal(r.o.hand_back.reason, "route_not_open");
		assert.equal(r.o.error.message, notOpen("register --name, --description and --homepage"));
		assert.equal(r.calls.length, 0, "nothing sent: no nameless passport is created");
		assert.equal(r.clients, 0);
	}
	// regression: without the new flags, register still goes to the server (passport route)
	const plain = await run(["register", "--agent-address", A1], { "/mandates/principal/passports": { status: 201, body: { passportId: P1, agentAddress: A1, reused: false } } });
	assert.notEqual(plain.code, 4);
	assert.ok(plain.calls.some((c) => c.pathname === "/mandates/principal/passports"));
});

test("agent-declared text limits: exit 2, zero requests (register and agent update)", async () => {
	const bad: string[][] = [
		["--name", ""],
		["--name", "x".repeat(65)],
		["--description", ""],
		["--description", "x".repeat(281)],
		["--name", "a" + cp(0x07) + "b"],
		["--name", "abc" + cp(0x202e) + "def"],
		["--description", "line\nbreak"],
		["--homepage", "http://rex.example"],
		["--homepage", "javascript:alert(1)"],
		["--homepage", "https://user:pw@rex.example"],
		["--homepage", "not a url"],
	];
	for (const f of bad) {
		for (const base of [["register", "--agent-address", A1], ["agent", "update", "--agent", P1]]) {
			const r = await run([...base, ...f]);
			assert.equal(r.code, 2, [...base, ...f].join(" "));
			assert.equal(r.calls.length, 0);
			assert.equal(r.clients, 0);
		}
	}
	// boundaries pass the local check (then stop at Not open)
	// 280 precomposed e-acute; 64 decomposed (e + U+0301, 128 code points before NFC); 64 astral (128 UTF-16 units)
	for (const f of [["--name", "x".repeat(64)], ["--description", cp(0xe9).repeat(280)], ["--name", ("e" + cp(0x301)).repeat(64)], ["--name", cp(0x1f600).repeat(64)]]) {
		const r = await run(["agent", "update", "--agent", P1, ...f]);
		assert.equal(r.code, 4, f[0]);
	}
});

test("checkAgentText: NFC first, then counted by code point", () => {
	assert.equal(checkAgentText("name", "e" + cp(0x301)), cp(0xe9));
	assert.throws(() => checkAgentText("name", cp(0x200b) + "x"), /control or format/);
});

test("agent update: no field is exit 2; any field is exit 4 Not open with zero requests; --agent is required", async () => {
	const none = await run(["agent", "update", "--agent", P1]);
	assert.equal(none.code, 2);
	const noAgent = await run(["agent", "update", "--name", "Rex"]);
	assert.equal(noAgent.code, 2);
	for (const argv of [["agent"], ["agent", "delete", "--agent", P1]]) assert.equal((await run(argv)).code, 2, argv.join(" "));
	const r = await run(["agent", "update", "--agent", P1, "--name", "Rex"]);
	assert.equal(r.code, 4);
	assert.equal(r.o.hand_back.reason, "route_not_open");
	assert.equal(r.o.error.message, notOpen("agent update"));
	assert.equal(r.calls.length, 0);
	assert.equal(r.clients, 0);
});

test("help text: the K-2 lines carry no banned word", () => {
	const lines = USAGE_TEXT.split("\n").filter((l) => /identity|agent update|--name|--description/.test(l));
	assert.ok(lines.length >= 3);
	for (const l of lines) assert.doesNotMatch(l, /verified|verification|approved|\btoken\b|invest|\byet\b|\bnone\b|\bzero\b|\bsoon\b/i, l);
});

test("one key across commands: whoami, agents, mandate show and identity show emit kya_state (raw), never kyaStatus", async () => {
	const M1 = "11111111-1111-4111-8111-111111111111";
	const one = { ...agent(P1, A1, "pending_review"), mandates: [{ mandateId: M1, status: "active" }] };
	const t = { [AGENTS]: { body: page([one]) }, [CHECKS]: { body: { checks: [] } } };
	const pick: [string[], (o: { data: Record<string, any> }) => unknown][] = [
		[["whoami"], (o) => o.data.agent],
		[["agents"], (o) => o.data.agents[0]],
		[["mandate", "show", M1], (o) => o.data.agent],
		[["identity", "show", "--agent", P1], (o) => o.data.passport],
	];
	for (const [argv, get] of pick) {
		const r = await run(argv, t);
		assert.equal(r.code, 0, argv.join(" "));
		const obj = get(r.o) as Record<string, unknown>;
		assert.equal(obj.kya_state, "pending_review", argv.join(" "));
		assert.doesNotMatch(r.raw, /kyaStatus/, argv.join(" "));
	}
});
