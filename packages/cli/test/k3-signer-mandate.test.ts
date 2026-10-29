// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-3: signer init/status/link (device key; link Not open), mandate request/request-change (hand-back), mandate revoke (read back).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { CommertizeClient } from "../src/index.ts";
import { checkValue, osKeychain, type Keychain, type KeyName, type Runner } from "../src/keychain.ts";
import { SIGNER_KEY } from "../src/signer.ts";
import { main } from "../src/cli.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableSigning } from "../src/receiptsigner.ts";

/** A home where the person has enabled signing (signer init and link are gated by the kill file). */
const enabledHome = () => {
	const h = mkdtempSync(join(tmpdir(), "kit-k3-home-"));
	enableSigning(h);
	return h;
};
const ENABLED_HOME = enabledHome();

const ENV = { baseUrl: "https://api.commertize.com", sessionToken: "SESSION-SECRET" };
const A1 = "0x" + "a".repeat(40);
const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M1 = "11111111-1111-4111-8111-111111111111";

function memKeychain(opts: { available?: boolean; tamperRead?: boolean } = {}) {
	const store = new Map<KeyName, string>();
	const kc: Keychain = {
		available: () => opts.available !== false,
		has: (n) => store.has(n),
		get: (n) => (opts.tamperRead && store.has(n) ? "MIGdifferent" + store.get(n)!.slice(12) : store.get(n)),
		set: (n, v) => void store.set(n, checkValue(v)),
		clear: (n) => store.delete(n),
		add: (n, v) => (store.has(n) ? "exists" : (store.set(n, checkValue(v)), "added")),
	};
	return { kc, store };
}

async function run(argv: string[], o: { kc?: Keychain; home?: string; api?: (method: string, path: string) => { status?: number; body: unknown } } = {}) {
	const calls: { method: string; path: string; auth?: string }[] = [];
	const f = (async (input: unknown, init?: RequestInit) => {
		const u = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push({ method, path: u.pathname, auth: (init?.headers as Record<string, string>)?.authorization });
		const a = o.api?.(method, u.pathname) ?? { status: 404, body: { error: "Not found" } };
		return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
	}) as typeof fetch;
	const out: string[] = [];
	const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, { client: () => new CommertizeClient(ENV, f), keychain: o.kc, home: o.home ?? ENABLED_HOME, signals: false });
	return { code, o: JSON.parse(out.at(-1)!), calls, raw: out.join("\n") };
}

// --- signer -------------------------------------------------------------------

test("signer init: a P-256 key in the keychain; prints the public key and its fingerprint, never the private key", async () => {
	const { kc, store } = memKeychain();
	const r = await run(["signer", "init"], { kc });
	assert.equal(r.code, 0);
	const priv = store.get(SIGNER_KEY)!;
	assert.ok(priv);
	assert.doesNotMatch(r.raw, new RegExp(priv.slice(20, 60).replace(/[-]/g, "\\-")), "the private key is never printed");
	const s = r.o.data.signer;
	const spki = Buffer.from(s.publicKey, "base64url");
	const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
	assert.equal(pub.asymmetricKeyDetails?.namedCurve, "prime256v1");
	assert.equal(s.fingerprint, "sha256:" + createHash("sha256").update(spki).digest("hex"));
	assert.equal(r.calls.length, 0, "local only");
	// status reads the same key back
	const st = await run(["signer", "status"], { kc });
	assert.equal(st.o.data.stored, true);
	assert.equal(st.o.data.signer.fingerprint, s.fingerprint);
	assert.equal(st.o.data.link, "Not open");
});

test("signer init never replaces a stored key; without a keychain nothing is stored; a changed read-back is never deleted", async () => {
	const { kc, store } = memKeychain();
	await run(["signer", "init"], { kc });
	const first = store.get(SIGNER_KEY);
	const again = await run(["signer", "init"], { kc });
	assert.equal(again.code, 1);
	assert.equal(again.o.hand_back.reason, "signer_exists");
	assert.equal(store.get(SIGNER_KEY), first);
	const none = memKeychain({ available: false });
	const n = await run(["signer", "init"], { kc: none.kc });
	// K-3: no supported OS keychain = the signer is Not open here (exit 4), never a file fallback.
	assert.equal(n.code, 4);
	assert.equal(n.o.error.code, "not_open");
	assert.match(n.o.error.message, /never kept in a file/);
	assert.equal(none.store.size, 0);
	const t = memKeychain({ tamperRead: true });
	const bad = await run(["signer", "init"], { kc: t.kc });
	assert.equal(bad.code, 1);
	assert.equal(t.store.has(SIGNER_KEY), true, "a key that reads back different is never deleted (it may be another init's)");
	assert.equal(bad.o.hand_back.reason, "signer_exists");
});

test("signer status refuses a stored value that is not a P-256 key this kit wrote", async () => {
	const { kc, store } = memKeychain();
	store.set(SIGNER_KEY, "MIIBnotakeyatallnotakeyatall");
	assert.equal((await run(["signer", "status"], { kc })).code, 1);
	const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
	store.set(SIGNER_KEY, ed);
	const r = await run(["signer", "status"], { kc });
	assert.equal(r.code, 1);
	assert.match(r.o.error.message, /not a P-256 key/);
	assert.equal((await run(["signer", "status"], { kc: memKeychain().kc })).o.data.stored, false);
});

test("signer link: needs a stored key, then stops as Not open (exit 4) before any network call", async () => {
	const { kc } = memKeychain();
	const no = await run(["signer", "link"], { kc });
	assert.equal(no.code, 1);
	await run(["signer", "init"], { kc });
	const r = await run(["signer", "link"], { kc });
	assert.equal(r.code, 4);
	assert.equal(r.o.hand_back.reason, "route_not_open");
	assert.equal(r.calls.length, 0);
	for (const argv of [["signer"], ["signer", "rotate"], ["signer", "init", "x"]]) assert.equal((await run(argv, { kc })).code, 2, argv.join(" "));
});

test("configure: the signer key can be cleared by name and is not listed as a credential", async () => {
	const { kc, store } = memKeychain();
	await run(["signer", "init"], { kc });
	const c = await run(["configure"], { kc });
	assert.deepEqual(Object.keys(c.o.data.stored), ["COMMERTIZE_SESSION_TOKEN", "COMMERTIZE_API_KEY"]);
	const cl = await run(["configure", "--clear", SIGNER_KEY, "--confirm"], { kc });
	assert.equal(cl.code, 0);
	assert.equal(store.has(SIGNER_KEY), false);
});

// --- mandate request / request-change ----------------------------------------------

test("mandate request / request-change: a hand-back to the principal's dashboard (exit 5), no network call, no draft written", async () => {
	const req = await run(["mandate", "request"]);
	assert.equal(req.code, 5);
	assert.deepEqual(req.o.hand_back, { reason: "mandate_request", by: "principal", url: "https://app.commertize.com/mandates/new" });
	assert.equal(req.o.data.sent, false);
	const chg = await run(["mandate", "request-change"]);
	assert.equal(chg.code, 5);
	assert.equal(chg.o.hand_back.url, "https://app.commertize.com/mandates");
	assert.equal(req.calls.length + chg.calls.length, 0);
	for (const argv of [["mandate", "request", M1], ["mandate", "request", "--confirm"], ["mandate", "request-change", "--dry-run"]]) assert.equal((await run(argv)).code, 2, argv.join(" "));
});

// --- mandate revoke -------------------------------------------------------------

const AGENTS = "/mandates/principal/agents";
const REVOKE = `/mandates/principal/${M1}/revoke`;
const pageWith = (status: string, endedAt: string | null = null) => ({
	nextCursor: null,
	agents: [{ passportId: P1, agentAddress: A1, kyaStatus: "active", mandates: [{ mandateId: M1, status, endedAt }] }],
});

/** A server whose mandate status changes when the revoke route is called (or does not, for the lying case). */
function server(opts: { start: string; startEnded?: string | null; afterRevoke?: string; revokeStatus?: number }) {
	let status = opts.start;
	let endedAt: string | null = opts.startEnded ?? null;
	return (method: string, path: string) => {
		if (method === "GET" && path === AGENTS) return { body: pageWith(status, endedAt) };
		if (method === "POST" && path === REVOKE) {
			if (opts.revokeStatus) return { status: opts.revokeStatus, body: { error: "Not found" } };
			if (opts.afterRevoke) {
				status = opts.afterRevoke;
				endedAt = opts.afterRevoke === "revoked" ? "2026-10-28T20:00:00.000Z" : null;
			}
			return { body: { ok: true } };
		}
		return { status: 404, body: {} };
	};
}

test("mandate revoke --confirm: reads, posts, reads back; reports the state it read back", async () => {
	const r = await run(["mandate", "revoke", M1, "--confirm"], { api: server({ start: "active", afterRevoke: "revoked" }) });
	assert.equal(r.code, 0);
	assert.deepEqual(r.o.data.before, { status: "active", endedAt: null });
	assert.deepEqual(r.o.data.after, { status: "revoked", endedAt: "2026-10-28T20:00:00.000Z" });
	assert.equal(r.o.data.sent, true);
	assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), [`GET ${AGENTS}`, `POST ${REVOKE}`, `GET ${AGENTS}`]);
	assert.equal(r.calls[1]!.auth, "Bearer SESSION-SECRET");
	assert.doesNotMatch(r.raw, /SESSION-SECRET/);
});

test("mandate revoke: an ok answer while the mandate still reads live is an error, never a claimed revoke", async () => {
	const r = await run(["mandate", "revoke", M1, "--confirm"], { api: server({ start: "active" }) });
	assert.equal(r.code, 1);
	assert.equal(r.o.hand_back.reason, "api_error");
	assert.match(r.o.error.message, /still reads as active; nothing is claimed/);
	const off = await run(["mandate", "revoke", M1, "--confirm"], { api: server({ start: "active", revokeStatus: 404 }) });
	assert.equal(off.code, 1, "a switched-off route is an error");
});

test("mandate revoke: an already-ended mandate sends nothing; --dry-run reads only; guards are usage errors before any call", async () => {
	const done = await run(["mandate", "revoke", M1, "--confirm"], { api: server({ start: "revoked", startEnded: "2026-10-01T00:00:00.000Z" }) });
	assert.equal(done.code, 0);
	assert.equal(done.o.data.already_ended, true);
	assert.ok(!done.calls.some((c) => c.method === "POST"));
	const ended = await run(["mandate", "revoke", M1, "--confirm"], { api: server({ start: "suspended", startEnded: "2026-10-01T00:00:00.000Z" }) });
	assert.ok(!ended.calls.some((c) => c.method === "POST"), "an endedAt alone counts as ended");
	const dry = await run(["mandate", "revoke", M1, "--dry-run"], { api: server({ start: "active", afterRevoke: "revoked" }) });
	assert.equal(dry.code, 0);
	assert.equal(dry.o.data.sent, false);
	assert.deepEqual(dry.calls.map((c) => c.method), ["GET"]);
	assert.match(dry.o.next_step, /--confirm/);
	for (const argv of [["mandate", "revoke", M1], ["mandate", "revoke", M1, "--confirm", "--dry-run"], ["mandate", "revoke", "nope", "--confirm"], ["mandate", "revoke"], ["mandate", "show", M1, "--confirm"]]) {
		const b = await run(argv, { api: server({ start: "active", afterRevoke: "revoked" }) });
		assert.equal(b.code, 2, argv.join(" "));
		assert.equal(b.calls.length, 0);
	}
	const missing = await run(["mandate", "revoke", "22222222-2222-4222-8222-222222222222", "--confirm"], { api: server({ start: "active" }) });
	assert.equal(missing.code, 16);
	assert.ok(!missing.calls.some((c) => c.method === "POST"));
});

test("a generated signer key passes the keychain value allowlist", () => {
	for (let i = 0; i < 20; i++) {
		const v = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
		assert.equal(checkValue(v), v);
	}
});

// --- review round 1: three-state lookups, create-only add, never delete a key this process did not write ---

/** The real osKeychain over a scripted runner: `find` and `add` statuses are chosen per test. */
function scripted(o: { find?: number; findValue?: () => string | undefined; add?: number }) {
	const calls: { args: string[]; input?: string }[] = [];
	const run: Runner = (args, input) => {
		calls.push({ args, input });
		if (args[0] === "-i") return { status: o.add ?? 0, stdout: "" };
		if (args[0] === "find-generic-password") {
			if (args.includes("-w")) {
				const v = o.findValue?.();
				return v === undefined ? { status: o.find ?? 44, stdout: "" } : { status: 0, stdout: v + "\n" };
			}
			return { status: o.find ?? 44, stdout: "" };
		}
		if (args[0] === "delete-generic-password") return { status: 0, stdout: "" };
		return { status: 1, stdout: "" };
	};
	return { kc: osKeychain(run, () => true), calls };
}

test("keychain lookups are three-state: 36 (locked or headless) stops signer init before any write; status and configure stop too", async () => {
	const s = scripted({ find: 36 });
	const r = await run(["signer", "init"], { kc: s.kc });
	assert.equal(r.code, 1);
	assert.match(r.o.error.message, /did not answer .*exit 36/);
	assert.ok(!s.calls.some((c) => c.args[0] === "-i" || c.args[0] === "delete-generic-password"), "no write, no delete");
	assert.equal((await run(["signer", "status"], { kc: scripted({ find: 36 }).kc })).code, 1);
	assert.equal((await run(["configure"], { kc: scripted({ find: 36 }).kc })).code, 1);
});

test("signer init adds without -U (create-only); an existing item (45) is never replaced or deleted", async () => {
	let written: string | undefined;
	const ok = scripted({ findValue: () => written });
	const base = ok.kc;
	const kc: Keychain = { ...base, add: (n, v) => ((written = v), base.add!(n, v)) };
	const r = await run(["signer", "init"], { kc });
	assert.equal(r.code, 0);
	const add = ok.calls.find((c) => c.args[0] === "-i")!;
	assert.match(add.input!, /^add-generic-password -s commertize-agent-kit -a COMMERTIZE_SIGNER_KEY -w /);
	assert.doesNotMatch(add.input!, / -U /);
	const dup = scripted({ add: 45 });
	const d = await run(["signer", "init"], { kc: dup.kc });
	assert.equal(d.code, 1);
	assert.equal(d.o.hand_back.reason, "signer_exists");
	assert.ok(!dup.calls.some((c) => c.args[0] === "delete-generic-password"));
});

test("signer init read-back: a different value (another init won) or a missing item is never deleted", async () => {
	const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
	const raced = scripted({ findValue: () => other });
	const kc: Keychain = { ...raced.kc, has: () => false };
	const r = await run(["signer", "init"], { kc });
	assert.equal(r.code, 1);
	assert.equal(r.o.hand_back.reason, "signer_exists");
	assert.ok(!raced.calls.some((c) => c.args[0] === "delete-generic-password"), "the other init's key is left alone");
	const gone = scripted({});
	const g = await run(["signer", "init"], { kc: gone.kc });
	assert.equal(g.code, 1);
	assert.match(g.o.error.message, /not in the keychain/);
	assert.ok(!gone.calls.some((c) => c.args[0] === "delete-generic-password"));
});

test("concurrent signer init: both see no key, only one create succeeds, the winner's key survives", async () => {
	const store = new Map<KeyName, string>();
	const kc: Keychain = {
		available: () => true,
		has: () => false, // both inits checked before either wrote
		get: (n) => store.get(n),
		set: () => {
			throw new Error("init must not use set (it replaces)");
		},
		clear: (n) => store.delete(n),
		add: (n, v) => (store.has(n) ? "exists" : (store.set(n, v), "added")),
	};
	const [a, b] = await Promise.all([run(["signer", "init"], { kc }), run(["signer", "init"], { kc })]);
	assert.deepEqual([a.code, b.code].sort(), [0, 1]);
	const winner = a.code === 0 ? a : b;
	assert.equal(store.size, 1);
	const spki = createPublicKey(createPrivateKey({ key: Buffer.from(store.get(SIGNER_KEY)!, "base64url"), format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
	assert.equal(winner.o.data.signer.fingerprint, "sha256:" + createHash("sha256").update(spki).digest("hex"));
});

test("keychain get(): a stored signer value outside the charset allowlist is refused, not parsed", async () => {
	const s = scripted({ findValue: () => "bad value; rm -rf" });
	const r = await run(["signer", "status"], { kc: s.kc });
	assert.equal(r.code, 1);
	assert.match(r.o.error.message, /disallowed shape/);
});

test("mandate revoke: expired, terminated or revoked with no endedAt counts as ended; nothing is sent", async () => {
	for (const st of ["expired", "terminated", "revoked"]) {
		const r = await run(["mandate", "revoke", M1, "--confirm"], { api: server({ start: st }) });
		assert.equal(r.code, 0, st);
		assert.equal(r.o.data.already_ended, true, st);
		assert.ok(!r.calls.some((c) => c.method === "POST"), st);
	}
});

test("agents: malformed rows are left out and counted (data.dropped_rows, whoami agents_dropped_rows)", async () => {
	const body = { nextCursor: null, agents: [{ passportId: "..", agentAddress: A1, kyaStatus: "active", mandates: [] }, { passportId: P1, agentAddress: A1, kyaStatus: "active", mandates: [] }, "junk"] };
	const r = await run(["agents"], { api: () => ({ body }) });
	assert.equal(r.o.data.agents.length, 1);
	assert.equal(r.o.data.dropped_rows, 2);
	const w = await run(["whoami"], { api: () => ({ body }) });
	assert.equal(w.o.data.agents_dropped_rows, 2);
});

// --- cross-review C1-C3 ------------------------------------------------------------

test("configure --clear is three-state: a locked keychain (36) stops, never reports 'was not stored'", async () => {
	const locked: Runner = (args) => (args[0] === "delete-generic-password" ? { status: 36, stdout: "" } : { status: 44, stdout: "" });
	const r = await run(["configure", "--clear", SIGNER_KEY, "--confirm"], { kc: osKeychain(locked, () => true) });
	assert.equal(r.code, 1);
	assert.match(r.o.error.message, /did not answer .*exit 36/);
	assert.doesNotMatch(r.raw, /was not stored/);
	const absent: Runner = () => ({ status: 44, stdout: "" });
	const a = await run(["configure", "--clear", SIGNER_KEY, "--confirm"], { kc: osKeychain(absent, () => true) });
	assert.equal(a.code, 0);
	assert.equal(a.o.data.action, `${SIGNER_KEY} was not stored`);
});

test("set() never writes a key item: it replaces existing items, so the signer key is create-only", () => {
	const calls: string[][] = [];
	const kc = osKeychain((args) => (calls.push(args), { status: 0, stdout: "" }), () => true);
	const v = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
	assert.throws(() => kc.set(SIGNER_KEY, v), /created once and never replaced/);
	assert.deepEqual(calls, [], "nothing reaches the keychain");
	assert.doesNotThrow(() => kc.set("COMMERTIZE_API_KEY", "kc_apikey_0123456789"));
});

test("configure shows whether a signer key is stored, never its value", async () => {
	const { kc, store } = memKeychain();
	const before = await run(["configure"], { kc });
	assert.equal(before.o.data.keys[SIGNER_KEY], false);
	await run(["signer", "init"], { kc });
	const after = await run(["configure"], { kc });
	assert.equal(after.o.data.keys[SIGNER_KEY], true);
	assert.ok(!after.raw.includes(store.get(SIGNER_KEY)!.slice(10, 50)));
});
