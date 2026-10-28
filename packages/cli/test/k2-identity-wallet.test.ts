// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-2: agents --use (active profile), identity show, wallet address / balance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommertizeClient } from "../src/index.ts";
import { formatUnits, NETWORKS } from "../src/chain.ts";
import { main } from "../src/cli.ts";

const ENV = { baseUrl: "https://api.commertize.com", sessionToken: "SESSION-SECRET" };
const A1 = "0x" + "a".repeat(40);
const A2 = "0x" + "b".repeat(40);
const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const P2 = "aaaaaaaa-0000-4000-8000-000000000002";
const agent = (pid: string, addr: string, kyaStatus = "active") => ({ passportId: pid, agentAddress: addr, kyaStatus, createdAt: "2026-10-01T00:00:00.000Z", revokedAt: null, mandates: [] });
const page = (agents: object[], extra: object = {}) => ({ nextCursor: null, principal_kyb_status: "unknown", principal_kyb_as_of: null, agents, ...extra });

type Answer = { status?: number; body: unknown };
async function run(argv: string[], table: Record<string, Answer | ((u: URL) => Answer)>, o: { home?: string; rpc?: typeof fetch } = {}) {
	const calls: URL[] = [];
	const f = (async (input: unknown) => {
		const u = new URL(String(input));
		calls.push(u);
		const hit = table[u.pathname];
		if (!hit) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
		const a = typeof hit === "function" ? hit(u) : hit;
		return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
	}) as typeof fetch;
	const out: string[] = [];
	const home = o.home ?? mkdtempSync(join(tmpdir(), "kit-home-"));
	const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, {
		client: () => new CommertizeClient(ENV, f),
		home,
		rpcFetch: o.rpc,
		signals: false,
	});
	return { code, o: JSON.parse(out.at(-1)!), calls, home, raw: out.join("\n") };
}
const AGENTS = "/mandates/principal/agents";

// --- agents --use -------------------------------------------------------------

test("agents --use: by address or passport id, writes ~/.commertize/profiles/default.json (0600 in 0700 dirs), and whoami then acts as that agent", async () => {
	const t = { [AGENTS]: { body: page([agent(P1, A1), agent(P2, A2)]) } };
	const r = await run(["agents", "--use", A2.toUpperCase().replace("0X", "0x")], t);
	assert.equal(r.code, 0);
	assert.equal(r.o.data.written, true);
	const file = join(r.home, ".commertize", "profiles", "default.json");
	assert.equal(r.o.data.path, file);
	assert.equal(lstatSync(file).mode & 0o777, 0o600);
	assert.equal(lstatSync(join(r.home, ".commertize")).mode & 0o777, 0o700);
	const stored = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual([stored.v, stored.passportId, stored.agentAddress], [1, P2, A2]);
	assert.doesNotMatch(readFileSync(file, "utf8"), /SESSION-SECRET/);
	const w = await run(["whoami"], t, { home: r.home });
	assert.equal(w.o.data.agent.passportId, P2);
	assert.equal(w.calls.length, 1);
	// by passport id, into a named profile
	const n = await run(["agents", "--use", P1, "--profile", "work"], t, { home: r.home });
	assert.equal(n.code, 0);
	assert.ok(existsSync(join(r.home, ".commertize", "profiles", "work.json")));
});

test("agents --use --dry-run writes nothing; a revoked or unknown agent is refused (16); bad combinations are usage errors", async () => {
	const t = { [AGENTS]: { body: page([agent(P1, A1), agent(P2, A2, "revoked")]) } };
	const d = await run(["agents", "--use", A1, "--dry-run"], t);
	assert.equal(d.code, 0);
	assert.equal(d.o.data.written, false);
	assert.equal(existsSync(join(d.home, ".commertize")), false);
	const rev = await run(["agents", "--use", A2], t);
	assert.equal(rev.code, 16);
	assert.match(rev.o.error.message, /revoked, not active/);
	assert.equal(existsSync(join(rev.home, ".commertize", "profiles", "default.json")), false);
	assert.equal((await run(["agents", "--use", "0x" + "c".repeat(40)], t)).code, 16);
	for (const argv of [["agents", "--use", "nope"], ["agents", "--use", A1, "--limit", "5"], ["agents", "--use", A1, "--profile", "../x"], ["agents", "--dry-run"], ["agents", "--profile", "work"]]) {
		const b = await run(argv, t);
		assert.equal(b.code, 2, argv.join(" "));
		assert.equal(b.calls.length, 0);
	}
});

test("profile reads fail closed: a symlinked directory, a symlinked file or a file this kit did not write stops the command", async () => {
	const t = { [AGENTS]: { body: page([agent(P1, A1)]) } };
	const h1 = mkdtempSync(join(tmpdir(), "kit-home-"));
	const elsewhere = mkdtempSync(join(tmpdir(), "kit-elsewhere-"));
	symlinkSync(elsewhere, join(h1, ".commertize"));
	const a = await run(["wallet", "address"], t, { home: h1 });
	assert.equal(a.code, 1);
	assert.match(a.o.error.message, /not a plain directory/);
	assert.equal((await run(["agents", "--use", A1], t, { home: h1 })).code, 1, "nor written through");
	assert.equal(existsSync(join(elsewhere, "profiles")), false);
	const h2 = mkdtempSync(join(tmpdir(), "kit-home-"));
	mkdirSync(join(h2, ".commertize", "profiles"), { recursive: true });
	writeFileSync(join(h2, ".commertize", "profiles", "default.json"), JSON.stringify({ v: 1, passportId: P1, agentAddress: "0xnot-an-address", setAt: "x" }));
	assert.equal((await run(["wallet", "address"], t, { home: h2 })).code, 1);
	const h3 = mkdtempSync(join(tmpdir(), "kit-home-"));
	mkdirSync(join(h3, ".commertize", "profiles"), { recursive: true });
	const real = join(h3, "real.json");
	writeFileSync(real, JSON.stringify({ v: 1, passportId: P1, agentAddress: A1, setAt: "x" }));
	symlinkSync(real, join(h3, ".commertize", "profiles", "default.json"));
	assert.equal((await run(["wallet", "address"], t, { home: h3 })).code, 1);
});

// --- identity show ------------------------------------------------------------

test("identity show: the passport and every KYA check row (malformed rows kept with nulls); the active profile is used when no --agent", async () => {
	const rows = [
		{ id: "r1", checkId: "kya.sanctions", result: "pass", policyVersion: "1", checkedAt: "2026-10-27T00:00:00.000Z" },
		{ id: "r2", checkId: 7, result: "pass" },
	];
	const t = { [AGENTS]: { body: page([agent(P1, A1)]) }, [`/kya/passports/${P1}/checks`]: { body: { checks: rows } } };
	const r = await run(["identity", "show", "--agent", A1], t);
	assert.equal(r.code, 0);
	assert.equal(r.o.data.passport.passportId, P1);
	assert.deepEqual(r.o.data.checks, [rows[0], { id: "r2", checkId: null, result: "pass", policyVersion: null, checkedAt: null }], "a malformed row is kept, never dropped");
	assert.equal(r.o.data.checks_note, null);
	assert.deepEqual(r.calls.map((c) => c.pathname), [AGENTS, `/kya/passports/${P1}/checks`]);
	const u = await run(["agents", "--use", A1], t);
	const viaProfile = await run(["identity", "show"], t, { home: u.home });
	assert.equal(viaProfile.code, 0);
	assert.equal(viaProfile.o.data.passport.agentAddress, A1);
});

test("identity show: a switched-off check record (404) is reported as unavailable, never as an empty list; a malformed answer is refused", async () => {
	const off = await run(["identity", "show", "--agent", P1], { [AGENTS]: { body: page([agent(P1, A1)]) } });
	assert.equal(off.code, 0);
	assert.equal(off.o.data.checks, null);
	assert.match(off.o.data.checks_note, /not available for this passport on this deployment/);
	const bad = await run(["identity", "show", "--agent", P1], { [AGENTS]: { body: page([agent(P1, A1)]) }, [`/kya/passports/${P1}/checks`]: { body: { checks: "all good" } } });
	assert.equal(bad.code, 1);
	assert.equal(bad.o.hand_back.reason, "api_error");
	const srv = await run(["identity", "show", "--agent", P1], { [AGENTS]: { body: page([agent(P1, A1)]) }, [`/kya/passports/${P1}/checks`]: { status: 500, body: {} } });
	assert.equal(srv.code, 1, "a 500 is an error, not 'switched off'");
});

test("identity show / wallet: no --agent and no active profile is exit 16 with a no_active_agent hand-back, before any network call", async () => {
	for (const argv of [["identity", "show"], ["wallet", "address"], ["wallet", "balance"]]) {
		let rpcCalls = 0;
		const r = await run(argv, {}, { rpc: (async () => (rpcCalls++, new Response("{}"))) as typeof fetch });
		assert.equal(r.code, 16, argv.join(" "));
		assert.equal(r.o.hand_back.reason, "no_active_agent");
		assert.equal(r.calls.length + rpcCalls, 0);
	}
	for (const argv of [["identity"], ["identity", "list"], ["wallet"], ["wallet", "send"], ["wallet", "address", "--network", "base"], ["wallet", "balance", "--network", "solana", "--agent", A1], ["wallet", "balance", "--token", "DAI", "--agent", A1], ["wallet", "address", "--agent", "0x12"]])
		assert.equal((await run(argv, {})).code, 2, argv.join(" "));
});

// --- wallet -------------------------------------------------------------------

function fakeRpc(answers: Record<string, unknown>) {
	const seen: { url: string; method: string; params: unknown[]; redirect?: string }[] = [];
	const f = (async (input: unknown, init?: RequestInit) => {
		const b = JSON.parse(String(init?.body));
		seen.push({ url: String(input), method: b.method, params: b.params, redirect: init?.redirect });
		const a = answers[b.method];
		return new Response(JSON.stringify(a === undefined ? { jsonrpc: "2.0", id: 1, error: { code: -32601 } } : { jsonrpc: "2.0", id: 1, result: a }), { status: 200 });
	}) as typeof fetch;
	return { f, seen };
}

test("wallet address: from --agent or the active profile; local only", async () => {
	const t = { [AGENTS]: { body: page([agent(P1, A1)]) } };
	const u = await run(["agents", "--use", A1], t);
	const a = await run(["wallet", "address"], {}, { home: u.home });
	assert.equal(a.code, 0);
	assert.deepEqual(a.o.data, { address: A1, source: "profile", passportId: P1 });
	// wallet address is local and never states a KYA status (revocation is whoami / identity show)
	assert.doesNotMatch(a.raw, /kya/i);
	assert.equal(a.calls.length, 0);
	assert.equal((await run(["wallet", "address", "--agent", A2], {})).o.data.address, A2);
});

test("wallet balance USDC: chain id checked first, balanceOf on the pinned contract, integer amounts", async () => {
	const word = "0x" + (1234567n).toString(16).padStart(64, "0");
	const { f, seen } = fakeRpc({ eth_chainId: "0x2105", eth_call: word });
	const r = await run(["wallet", "balance", "--agent", A1], {}, { rpc: f });
	assert.equal(r.code, 0);
	assert.deepEqual(r.o.data, { network: "base", chainId: 8453, address: A1, token: "USDC", contract: NETWORKS.base.usdc, raw: "1234567", decimals: 6, formatted: "1.234567" });
	assert.deepEqual(seen.map((s) => [s.url, s.method]), [["https://mainnet.base.org", "eth_chainId"], ["https://mainnet.base.org", "eth_call"]]);
	assert.deepEqual(seen[1]!.params, [{ to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: "0x70a08231" + "0".repeat(24) + "a".repeat(40) }, "latest"]);
	assert.equal(r.calls.length, 0, "no Commertize API call");
});

test("wallet balance ETH on base-sepolia: eth_getBalance, 18 decimals", async () => {
	const { f, seen } = fakeRpc({ eth_chainId: "0x14a34", eth_getBalance: "0xde0b6b3a7640001" });
	const r = await run(["wallet", "balance", "--network", "base-sepolia", "--token", "eth", "--agent", A1], {}, { rpc: f });
	assert.equal(r.code, 0);
	assert.equal(r.o.data.raw, (10n ** 18n + 1n).toString());
	assert.equal(r.o.data.formatted, "1." + "0".repeat(17) + "1");
	assert.equal(r.o.data.contract, null);
	assert.equal(seen[0]!.url, "https://sepolia.base.org");
	assert.deepEqual(seen[1]!.params, [A1, "latest"]);
});

test("wallet balance fails closed: wrong chain id stops before the balance read; malformed or error answers are refused", async () => {
	const wrong = fakeRpc({ eth_chainId: "0x1", eth_call: "0x" + "0".repeat(64) });
	const a = await run(["wallet", "balance", "--agent", A1], {}, { rpc: wrong.f });
	assert.equal(a.code, 1);
	assert.equal(a.o.hand_back.reason, "api_error");
	assert.match(a.o.error.message, /is not chain 8453/);
	assert.equal(wrong.seen.length, 1, "no balance read after a chain mismatch");
	for (const ans of [{ eth_chainId: "0x2105", eth_call: "0x01" }, { eth_chainId: "0x2105", eth_call: "0x" + "g".repeat(64) }, { eth_chainId: "0x2105" }, { eth_chainId: "banana" }]) {
		const b = await run(["wallet", "balance", "--agent", A1], {}, { rpc: fakeRpc(ans).f });
		assert.equal(b.code, 1, JSON.stringify(ans));
		assert.equal(b.o.data, null);
	}
});

test("formatUnits: integer math at the edges", () => {
	assert.equal(formatUnits(0n, 6), "0");
	assert.equal(formatUnits(1n, 6), "0.000001");
	assert.equal(formatUnits(1000000n, 6), "1");
	assert.equal(formatUnits(1234500n, 6), "1.2345");
	assert.equal(formatUnits(2n ** 256n - 1n, 6), "115792089237316195423570985008687907853269984665640564039457584007913129.639935");
	assert.equal(formatUnits(10n ** 18n + 1n, 18), "1." + "0".repeat(17) + "1");
	assert.throws(() => formatUnits(-1n, 6));
});

test("wallet balance: an RPC answer carrying an error is refused even when it also carries a result", async () => {
	const f = (async (_i: unknown, init?: RequestInit) =>
		JSON.parse(String(init?.body)).method === "eth_chainId"
			? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2105", error: { code: -32000, message: "x" } }))
			: new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "0".repeat(64) }))) as typeof fetch;
	const r = await run(["wallet", "balance", "--agent", A1], {}, { rpc: f });
	assert.equal(r.code, 1);
	assert.equal(r.o.hand_back.reason, "api_error");
});

// --- review round 1: check rows kept, ids pattern-checked, redirect pinned ------

test("identity show: a failed check with no date is shown as a fail, never dropped; a row with no result refuses the answer", async () => {
	const base = { [AGENTS]: { body: page([agent(P1, A1)]) } };
	const fail = await run(["identity", "show", "--agent", A1], { ...base, [`/kya/passports/${P1}/checks`]: { body: { checks: [{ id: "r9", checkId: "kya.sanctions", result: "fail", policyVersion: "1", checkedAt: null }] } } });
	assert.equal(fail.code, 0);
	assert.equal(fail.o.data.checks.length, 1);
	assert.equal(fail.o.data.checks[0].result, "fail");
	assert.equal(fail.o.data.checks[0].checkedAt, null);
	const text: string[] = [];
	const h = fail.home;
	await main(["identity", "show", "--agent", A1], (l) => text.push(l), () => {}, {
		client: () =>
			new CommertizeClient(ENV, (async (i: unknown) => {
				const p = new URL(String(i)).pathname;
				return new Response(JSON.stringify(p === AGENTS ? page([agent(P1, A1)]) : { checks: [{ result: "fail", checkedAt: null }] }));
			}) as typeof fetch),
		home: h,
		signals: false,
	});
	assert.match(text.join("\n"), /KYA checks: 1/);
	assert.match(text.join("\n"), /fail .*\(no date\)/);
	const noResult = await run(["identity", "show", "--agent", A1], { ...base, [`/kya/passports/${P1}/checks`]: { body: { checks: [{ id: "r1", checkId: "x", checkedAt: "2026-10-27T00:00:00Z" }] } } });
	assert.equal(noResult.code, 1);
	assert.match(noResult.o.error.message, /no result/);
});

test("agents list: a passport id that is not a UUID or an address that is not 0x+40 hex never reaches a URL", async () => {
	const evil = [
		{ passportId: "..", agentAddress: A1, kyaStatus: "active", mandates: [] },
		{ passportId: P2, agentAddress: "0x" + "a".repeat(39) + "/", kyaStatus: "active", mandates: [] },
	];
	const r = await run(["identity", "show", "--agent", A1], { [AGENTS]: { body: page(evil) } });
	assert.equal(r.code, 16);
	assert.ok(r.calls.every((c) => c.pathname === AGENTS), r.calls.map((c) => c.pathname).join(","));
	const l = await run(["agents"], { [AGENTS]: { body: page(evil) } });
	assert.deepEqual(l.o.data.agents, []);
});

test("wallet balance: every RPC request is sent with redirect: error", async () => {
	const { f, seen } = fakeRpc({ eth_chainId: "0x2105", eth_call: "0x" + "0".repeat(64) });
	assert.equal((await run(["wallet", "balance", "--agent", A1], {}, { rpc: f })).code, 0);
	assert.equal(seen.length, 2);
	assert.ok(seen.every((s) => s.redirect === "error"));
});
