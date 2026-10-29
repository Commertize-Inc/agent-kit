// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-3: the device signer attests only the two allow-listed request schemas; the kill file is checked
// before any key read; mandate request --caps checks locally, then stops as Not open with nothing sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommertizeClient } from "../src/index.ts";
import { checkValue, type Keychain, type KeyName } from "../src/keychain.ts";
import { ATTEST_DOMAIN, ATTEST_TYPES, attestDigest, checkAttestPayload, NotAllowlistedError, signerAttest } from "../src/attest.ts";
import { DisabledError, enableSigning, killFilePath } from "../src/receiptsigner.ts";
import { SIGNER_KEY, signerInit } from "../src/signer.ts";
import { canonicalize } from "../src/canonical.ts";
import { errorResult, main } from "../src/cli.ts";

const ENV = { baseUrl: "https://api.commertize.com", sessionToken: "SESSION-SECRET" };
const P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const M1 = "11111111-1111-4111-8111-111111111111";
const NONCE = "ab".repeat(32);
const NOW = new Date("2026-10-28T00:00:00Z");
const CAPS = { perCallUsdCents: "100", dailyUsdCents: "1000", totalUsdCents: "10000" };

function memKeychain() {
	const store = new Map<KeyName, string>();
	let reads = 0;
	const kc: Keychain = {
		available: () => true,
		has: (n) => store.has(n),
		get: (n) => (reads++, store.get(n)),
		set: (n, v) => void store.set(n, checkValue(v)),
		clear: (n) => store.delete(n),
		add: (n, v) => (store.has(n) ? "exists" : (store.set(n, checkValue(v)), "added")),
	};
	return { kc, store, reads: () => reads };
}
const newHome = () => mkdtempSync(join(tmpdir(), "kit-k3a-home-"));
const enabledHome = () => {
	const h = newHome();
	enableSigning(h);
	return h;
};

const mandateReq = (m: Record<string, unknown> = {}) => ({
	domain: { ...ATTEST_DOMAIN },
	primaryType: "MandateSignatureRequest",
	message: { passportId: P1, level: "L1", caps: { ...CAPS }, expiresAt: "2026-11-28T00:00:00Z", nonce: NONCE, ...m },
});
const capIncrease = (m: Record<string, unknown> = {}) => ({
	domain: { ...ATTEST_DOMAIN },
	primaryType: "CapIncreaseRequest",
	message: { mandateId: M1, fromCaps: { ...CAPS }, toCaps: { ...CAPS, dailyUsdCents: "2000" }, nonce: NONCE, ...m },
});

function withKey() {
	const k = memKeychain();
	const s = signerInit(k.kc);
	return { ...k, pub: createPublicKey({ key: Buffer.from(s.publicKey, "base64url"), format: "der", type: "spki" }), fingerprint: s.fingerprint };
}

// --- allow-list -----------------------------------------------------------------

test("exactly two schemas are allow-listed", () => {
	assert.deepEqual([...ATTEST_TYPES].sort(), ["CapIncreaseRequest", "MandateSignatureRequest"]);
});

test("both allow-listed schemas are attested: P-256 over the canonical payload, verifiable with the public key", () => {
	const k = withKey();
	const home = enabledHome();
	for (const p of [mandateReq(), capIncrease()]) {
		const a = signerAttest(k.kc, home, p, NOW);
		assert.equal(a.primaryType, p.primaryType);
		assert.equal(a.fingerprint, k.fingerprint);
		assert.equal(a.digest, "sha256:" + attestDigest(p as never).toString("hex"));
		assert.ok(verify("sha256", Buffer.from(canonicalize(p)), { key: k.pub, dsaEncoding: "ieee-p1363" }, Buffer.from(a.signature, "base64url")));
		assert.doesNotMatch(JSON.stringify(a), new RegExp(k.store.get(SIGNER_KEY)!.slice(30, 70).replace(/-/g, "\\-")), "the private key is never returned");
	}
});

const REFUSED: [string, unknown][] = [
	["not an object", "MandateSignatureRequest"],
	["array", [mandateReq()]],
	["EIP-2612 permit", { ...mandateReq(), primaryType: "Permit" }],
	["Permit2", { ...mandateReq(), primaryType: "PermitSingle" }],
	["prototype key toString", { ...mandateReq(), primaryType: "toString" }],
	["prototype key __proto__", { ...mandateReq(), primaryType: "__proto__" }],
	["primaryType not a string", { ...mandateReq(), primaryType: 1 }],
	["other domain name", { ...mandateReq(), domain: { name: "Permit2", version: "1" } }],
	["other domain version", { ...mandateReq(), domain: { name: ATTEST_DOMAIN.name, version: "2" } }],
	["domain with chainId", { ...mandateReq(), domain: { ...ATTEST_DOMAIN, chainId: 8453 } }],
	["extra top-level types", { ...mandateReq(), types: {} }],
	["missing message", { domain: { ...ATTEST_DOMAIN }, primaryType: "MandateSignatureRequest" }],
	["extra message field (spender)", mandateReq({ spender: "0x" + "1".repeat(40) })],
	["missing message field", (() => { const p = mandateReq(); delete (p.message as Record<string, unknown>).nonce; return p; })()],
	["level L3", mandateReq({ level: "L3" })],
	["level lower-case", mandateReq({ level: "l1" })],
	["passportId not a UUID", mandateReq({ passportId: "0x" + "a".repeat(40) })],
	["nonce short", mandateReq({ nonce: "ab" })],
	["nonce upper-case", mandateReq({ nonce: "AB".repeat(32) })],
	["expired", mandateReq({ expiresAt: "2026-10-27T00:00:00Z" })],
	["expires now", mandateReq({ expiresAt: "2026-10-28T00:00:00Z" })],
	["expires not Z", mandateReq({ expiresAt: "2026-11-28T00:00:00+01:00" })],
	["cap as a number", mandateReq({ caps: { ...CAPS, perCallUsdCents: 100 } })],
	["cap as a float string", mandateReq({ caps: { ...CAPS, perCallUsdCents: "1.5" } })],
	["cap zero", mandateReq({ caps: { ...CAPS, perCallUsdCents: "0" } })],
	["cap leading zero", mandateReq({ caps: { ...CAPS, perCallUsdCents: "0100" } })],
	["cap negative", mandateReq({ caps: { ...CAPS, perCallUsdCents: "-1" } })],
	["cap 19 digits", mandateReq({ caps: { perCallUsdCents: "1", dailyUsdCents: "1", totalUsdCents: "1" + "0".repeat(18) } })],
	["extra cap key", mandateReq({ caps: { ...CAPS, payee: "x" } })],
	["per call above daily", mandateReq({ caps: { ...CAPS, perCallUsdCents: "1001" } })],
	["daily above total", mandateReq({ caps: { ...CAPS, dailyUsdCents: "10001" } })],
	["cap increase lowers one cap", capIncrease({ toCaps: { ...CAPS, dailyUsdCents: "2000", perCallUsdCents: "99" } })],
	["cap increase increases nothing", capIncrease({ toCaps: { ...CAPS } })],
	["cap increase mandateId not a UUID", capIncrease({ mandateId: "m-1" })],
	["cap increase with mandate fields mixed in", capIncrease({ level: "L1" })],
	["mandate request with cap-increase fields", { ...capIncrease(), primaryType: "MandateSignatureRequest" }],
];

test("everything outside the two schemas is refused before the keychain is read", () => {
	const k = withKey();
	const home = enabledHome();
	const before = k.reads();
	for (const [name, p] of REFUSED) {
		assert.throws(() => signerAttest(k.kc, home, p, NOW), NotAllowlistedError, name);
		assert.throws(() => checkAttestPayload(p, NOW), (e: unknown) => e instanceof NotAllowlistedError && e.code === "TYPED_DATA_NOT_ALLOWLISTED", name);
	}
	assert.equal(k.reads(), before, "no refused payload reached the key");
});

test("boundaries that pass: per call == daily == total, an increase of one cent, an 18-digit cap", () => {
	const eq = { perCallUsdCents: "5", dailyUsdCents: "5", totalUsdCents: "5" };
	checkAttestPayload(mandateReq({ caps: eq }), NOW);
	checkAttestPayload(capIncrease({ fromCaps: eq, toCaps: { ...eq, totalUsdCents: "6" } }), NOW);
	checkAttestPayload(mandateReq({ caps: { ...CAPS, totalUsdCents: "9".repeat(18) } }), NOW);
	checkAttestPayload(mandateReq({ expiresAt: "2026-10-28T00:00:00.001Z" }), NOW);
});

// --- kill file --------------------------------------------------------------------

test("kill file: present in any form, or signing never enabled, stops the signer before the keychain is read", () => {
	const k = withKey();
	const reads = () => k.reads();
	const cases: [string, () => string][] = [
		["never enabled", newHome],
		["DISABLED file", () => { const h = enabledHome(); writeFileSync(killFilePath(h), "x"); return h; }],
		["DISABLED dangling symlink", () => { const h = enabledHome(); symlinkSync(join(h, "nowhere"), killFilePath(h)); return h; }],
		["DISABLED directory", () => { const h = enabledHome(); mkdirSync(killFilePath(h)); return h; }],
	];
	for (const [name, mk] of cases) {
		const before = reads();
		assert.throws(() => signerAttest(k.kc, mk(), mandateReq(), NOW), DisabledError, name);
		assert.equal(reads(), before, `${name}: key not read`);
	}
	// The kill file wins even over a refused payload: nothing about the payload is looked at first.
	const h = enabledHome();
	writeFileSync(killFilePath(h), "x");
	assert.throws(() => signerAttest(k.kc, h, { primaryType: "Permit" }, NOW), DisabledError);
});

async function run(argv: string[], o: { kc?: Keychain; home: string }) {
	const calls: string[] = [];
	const f = (async (input: unknown) => (calls.push(String(input)), new Response("{}", { status: 404 }))) as typeof fetch;
	const out: string[] = [];
	const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, { client: () => new CommertizeClient(ENV, f), keychain: o.kc, home: o.home, signals: false });
	return { code, o: JSON.parse(out.at(-1)!), calls };
}

test("signer init and link: exit 19 with the kill file, nothing stored, no network; status stays open", async () => {
	const k = memKeychain();
	const h = enabledHome();
	writeFileSync(killFilePath(h), "x");
	const init = await run(["signer", "init"], { kc: k.kc, home: h });
	assert.equal(init.code, 19);
	assert.equal(k.store.size, 0);
	const fresh = await run(["signer", "init"], { kc: k.kc, home: newHome() });
	assert.equal(fresh.code, 19, "signing is off by default");
	assert.equal(k.store.size, 0);
	signerInit(k.kc);
	const reads = k.reads();
	const link = await run(["signer", "link"], { kc: k.kc, home: h });
	assert.equal(link.code, 19);
	assert.equal(k.reads(), reads, "link read no key");
	const st = await run(["signer", "status"], { kc: k.kc, home: h });
	assert.equal(st.code, 0);
	assert.equal(init.calls.length + link.calls.length + st.calls.length, 0);
});

// --- mandate request --caps ----------------------------------------------------------

const capsFile = (v: unknown) => {
	const d = mkdtempSync(join(tmpdir(), "kit-k3a-caps-"));
	const p = join(d, "caps.json");
	writeFileSync(p, JSON.stringify(v));
	return p;
};

test("mandate request --caps: checked locally, then Not open (exit 4); nothing signed, nothing sent", async () => {
	const k = withKey();
	const home = enabledHome();
	const reads = k.reads();
	const r = await run(["mandate", "request", "--caps", capsFile(CAPS), "--level", "L1", "--expires", "2099-01-01T00:00:00Z", "--agent", P1], { kc: k.kc, home });
	assert.equal(r.code, 4);
	assert.equal(r.o.error.code, "route_missing");
	assert.match(r.o.error.message, /\/mandates\/principal\/requests/);
	const c = await run(["mandate", "request-change", "--caps", capsFile({ fromCaps: CAPS, toCaps: { ...CAPS, totalUsdCents: "20000" } }), "--mandate", M1], { kc: k.kc, home });
	assert.equal(c.code, 4);
	assert.equal(r.calls.length + c.calls.length, 0, "nothing sent");
	assert.equal(k.reads(), reads, "the key is not read: nothing is signed while the route is Not open");
});

test("mandate request --caps: a request outside the schema is a usage error (exit 2), still nothing sent", async () => {
	const home = enabledHome();
	const bad: string[][] = [
		["mandate", "request", "--caps", capsFile({ ...CAPS, perCallUsdCents: 1.5 }), "--level", "L1", "--expires", "2099-01-01T00:00:00Z", "--agent", P1],
		["mandate", "request", "--caps", capsFile(CAPS), "--level", "L3", "--expires", "2099-01-01T00:00:00Z", "--agent", P1],
		["mandate", "request", "--caps", capsFile(CAPS), "--level", "L1", "--expires", "2001-01-01T00:00:00Z", "--agent", P1],
		["mandate", "request", "--caps", capsFile(CAPS), "--level", "L1", "--agent", P1],
		["mandate", "request-change", "--caps", capsFile({ fromCaps: CAPS, toCaps: { ...CAPS, totalUsdCents: "9999" } }), "--mandate", M1],
		["mandate", "request-change", "--caps", capsFile({ fromCaps: CAPS, toCaps: CAPS, spender: "x" }), "--mandate", M1],
		["mandate", "request-change", "--caps", capsFile({ fromCaps: CAPS, toCaps: { ...CAPS, totalUsdCents: "20000" } }), "--mandate", M1, "--level", "L1"],
		["mandate", "request", "--level", "L1"],
		["mandate", "show", M1, "--agent", P1],
	];
	for (const argv of bad) {
		const r = await run(argv, { home });
		assert.equal(r.code, 2, argv.join(" "));
		assert.equal(r.calls.length, 0);
	}
});

test("mandate request --caps: the kill file stops it (exit 19) before the caps file is read", async () => {
	const h = enabledHome();
	writeFileSync(killFilePath(h), "x");
	const r = await run(["mandate", "request", "--caps", join(h, "does-not-exist.json"), "--level", "L1", "--expires", "2099-01-01T00:00:00Z", "--agent", P1], { home: h });
	assert.equal(r.code, 19);
	assert.equal(r.calls.length, 0);
	// The hand-back form (no --caps) sends nothing and stays open.
	const hb = await run(["mandate", "request"], { home: h });
	assert.equal(hb.code, 5);
});

// --- review LOW-1: check-then-sign through accessors / Proxy -----------------------------

test("a getter that answers the allow-list once and something else at signing is refused; nothing signed", () => {
	const k = withKey();
	const home = enabledHome();
	let n = 0;
	const p = mandateReq() as Record<string, unknown>;
	Object.defineProperty(p, "primaryType", { enumerable: true, get: () => (n++ === 0 ? "MandateSignatureRequest" : "TransferRequest") });
	const before = k.reads();
	assert.throws(() => signerAttest(k.kc, home, p, NOW), NotAllowlistedError);
	assert.equal(k.reads(), before, "key not read");
});

test("a getter nested in caps is refused; a Proxy, a symbol key and a class instance are refused", () => {
	const k = withKey();
	const home = enabledHome();
	const nested = mandateReq();
	const caps = { ...CAPS } as Record<string, unknown>;
	let n = 0;
	Object.defineProperty(caps, "totalUsdCents", { enumerable: true, get: () => (n++ === 0 ? "10000" : "999999999999") });
	(nested.message as Record<string, unknown>).caps = caps;
	const sym = mandateReq() as Record<PropertyKey, unknown>;
	sym[Symbol("x")] = 1;
	class C { domain = { ...ATTEST_DOMAIN }; primaryType = "MandateSignatureRequest"; message = mandateReq().message; }
	const before = k.reads();
	for (const [name, p] of [["nested getter", nested], ["proxy", new Proxy(mandateReq(), {})], ["proxy message", { ...mandateReq(), message: new Proxy(mandateReq().message, {}) }], ["symbol key", sym], ["class instance", new C()]] as [string, unknown][])
		assert.throws(() => signerAttest(k.kc, home, p, NOW), NotAllowlistedError, name);
	assert.equal(k.reads(), before);
});

test("the signature covers the snapshot: mutating the caller's object afterwards changes nothing that was signed", () => {
	const k = withKey();
	const p = mandateReq();
	const a = signerAttest(k.kc, enabledHome(), p, NOW);
	const signed = mandateReq();
	(p.message as Record<string, unknown>).level = "L2";
	assert.ok(verify("sha256", Buffer.from(canonicalize(signed)), { key: k.pub, dsaEncoding: "ieee-p1363" }, Buffer.from(a.signature, "base64url")));
});

test("an allow-list refusal surfaces as TYPED_DATA_NOT_ALLOWLISTED, never as a missing route", () => {
	const r = errorResult("signer", new NotAllowlistedError("x"));
	assert.equal(r.error?.code, "TYPED_DATA_NOT_ALLOWLISTED");
	assert.equal(r.hand_back?.reason, "typed_data_not_allowlisted");
	assert.notEqual(r.hand_back?.reason, "route_not_open");
	assert.equal(r.exit_code, 4);
});

test("mandate request / request-change --caps never build a client and never fetch", async () => {
	const home = enabledHome();
	let built = 0;
	const fetched: unknown[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (u: unknown) => (fetched.push(u), new Response("{}"))) as typeof fetch;
	try {
		for (const argv of [
			["mandate", "request", "--caps", capsFile(CAPS), "--level", "L1", "--expires", "2099-01-01T00:00:00Z", "--agent", P1],
			["mandate", "request-change", "--caps", capsFile({ fromCaps: CAPS, toCaps: { ...CAPS, totalUsdCents: "20000" } }), "--mandate", M1],
			["mandate", "request", "--caps", capsFile({ bad: 1 }), "--level", "L1", "--expires", "2099-01-01T00:00:00Z", "--agent", P1],
		]) {
			const out: string[] = [];
			const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, { client: () => (built++, new CommertizeClient(ENV, globalThis.fetch)), home, signals: false });
			assert.ok(code === 4 || code === 2, argv.join(" "));
		}
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.equal(built, 0, "no client built");
	assert.equal(fetched.length, 0, "no fetch");
});
