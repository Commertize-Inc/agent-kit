// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-4b: receipt signatures with the agent key (CAS-1 5.1.1), against the cas-spec conformance vectors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "../src/keccak.ts";
import { addressOf, AGENT_KEY } from "../src/agentkey.ts";
import { agentKeyReceiptLog, DisabledError, enableSigning, killFilePath, receiptDigest, signCasHash } from "../src/receiptsigner.ts";
import { N, recoverAddress } from "../src/secp256k1.ts";
import { validateReceipt, type Signer } from "../src/cas.ts";
import { checkValue, type Keychain, type KeyName } from "../src/keychain.ts";
import { loadReceiptVectors, readPin, type ReceiptVectorCase } from "./receipt-fixture.ts";
import * as index from "../src/index.ts";
import { main } from "../src/cli.ts";

// The vectors are fetched from cas-spec at the pinned commit and checked against the integrity pin
// (receipt-fixture.ts); nothing is committed here. Offline, or on any mismatch, every vector test
// FAILS with "fixture unavailable: <reason>" (never skipped). [requires-network]
const pin = readPin();
const loaded = await loadReceiptVectors().then(
	(r) => ({ ok: true as const, ...r }),
	(e: Error) => ({ ok: false as const, reason: e.message })
);
function vectors(): ReceiptVectorCase[] {
	if (!loaded.ok) assert.fail(loaded.reason);
	return loaded.vectors;
}

/** The documented derivation (cas-spec conformance/README.md): block i = keccak256(utf8(seed) || uint32_be(i)); keep 1 <= d < n. */
function deriveKeys(seed: string, count: number): string[] {
	const out: string[] = [];
	for (let i = 0; out.length < count; i++) {
		const be = Buffer.alloc(4);
		be.writeUInt32BE(i);
		const d = BigInt("0x" + Buffer.from(keccak256(Buffer.concat([Buffer.from(seed, "utf8"), be]))).toString("hex"));
		if (d >= 1n && d < N) out.push("0x" + d.toString(16).padStart(64, "0"));
	}
	return out;
}
const keys = deriveKeys(pin.seed, 6);

function memKeychain(priv?: string) {
	const store = new Map<KeyName, string>();
	if (priv) store.set(AGENT_KEY, priv);
	const reads: KeyName[] = [];
	const kc: Keychain = {
		available: () => true,
		has: (n) => store.has(n),
		get: (n) => (reads.push(n), store.get(n)),
		set: () => {
			throw new Error("no set");
		},
		clear: (n) => store.delete(n),
		add: (n, v) => (store.has(n) ? "exists" : (store.set(n, checkValue(v)), "added")),
	};
	return { kc, reads };
}
/** A fresh home (signing off by default). */
const freshHome = () => mkdtempSync(join(tmpdir(), "kit-k4b-home-"));
/** A home where the person has enabled signing. */
const home = () => {
	const h = freshHome();
	enableSigning(h);
	return h;
};
const disable = (h: string) => {
	mkdirSync(join(h, ".commertize"), { recursive: true });
	writeFileSync(killFilePath(h), "");
};

// --- conformance vectors ------------------------------------------------------------

test("[requires-network] fixture: fetched from cas-spec at the pinned commit and matching the integrity pin", () => {
	if (!loaded.ok) assert.fail(loaded.reason);
	assert.equal("sha256-" + createHash("sha256").update(loaded.raw).digest("base64"), pin.integrity);
	assert.ok(loaded.vectors.length >= 30);
	// No field anywhere in the file is a private key (field names checked, not prose).
	const names = new Set<string>();
	JSON.parse(loaded.raw.toString("utf8"), (k, v) => (names.add(k), v));
	assert.ok(![...names].some((k) => /priv|secret|seed/i.test(k)), "the vectors carry no private key field");
});

test("fixture loader: a failed fetch or a changed byte is a failure with the reason, never a skip", async () => {
	await assert.rejects(() => loadReceiptVectors((async () => { throw new Error("offline"); }) as unknown as typeof fetch), /fixture unavailable: could not fetch .*offline.*requires-network/);
	await assert.rejects(() => loadReceiptVectors((async () => new Response("nope", { status: 404 })) as typeof fetch), /fixture unavailable: .*HTTP 404/);
	await assert.rejects(() => loadReceiptVectors((async () => new Response('{"vectors":[]}')) as typeof fetch), /fixture unavailable: integrity mismatch/);
	assert.match(pin.url, new RegExp(`/cas-spec/${pin.commit}/`), "the URL pins a commit, not a branch");
	// The repository holds no copy of the vectors (and no encoded copy).
	const files = readdirSync(fileURLToPath(new URL("./fixtures/", import.meta.url)));
	assert.deepEqual(files, ["cas-1.0-receipt-secp256k1.pin.json"]);
});

test("[requires-network] every valid vector is reproduced byte for byte from the re-derived throwaway key", () => {
	const valid = vectors().filter((v) => v.expected.valid);
	assert.ok(valid.length >= 10);
	for (const v of valid) {
		const priv = keys[v.keyIndex!]!;
		assert.equal(addressOf(priv).toLowerCase(), v.signature.key_id, v.name);
		assert.equal("0x" + Buffer.from(receiptDigest(v.hash)).toString("hex"), v.digest, v.name);
		const s = signCasHash(v.hash, priv);
		assert.deepEqual(s, v.signature, v.name);
		assert.equal("0x" + Buffer.from(s.sig, "base64url").toString("hex"), v.sigHex, v.name);
	}
});

test("[requires-network] signature-level invalid vectors do not recover to key_id with the kit's own recovery", () => {
	const file = { vectors: vectors() };
	for (const v of file.vectors.filter((x) => x.expected.reason === "BAD_SIGNATURE" && x.sigHex && x.digest)) {
		const sig = Buffer.from(v.sigHex!.slice(2), "hex");
		let rec: string | null = null;
		try {
			rec = recoverAddress(Buffer.from(v.digest!.slice(2), "hex"), sig).toLowerCase();
		} catch {
			rec = null;
		}
		assert.ok(rec === null || rec !== v.signature.key_id, v.name);
	}
	for (const v of file.vectors.filter((x) => x.expected.valid))
		assert.equal(recoverAddress(Buffer.from(v.digest!.slice(2), "hex"), Buffer.from(v.sigHex!.slice(2), "hex")).toLowerCase(), v.signature.key_id, v.name);
});

// --- the agent-key receipt log --------------------------------------------------------

test("agentKeyReceiptLog: the log builds the record and signs its own hash; receipts validate and recover to the agent", async () => {
	const priv = keys[0]!;
	const { kc } = memKeychain(priv);
	const log = agentKeyReceiptLog({ mandateId: "m-1", agentId: "agent-1" }, { keychain: kc, home: home() });
	const a = await log.record({ verb: "read", objectRef: "listing:1", evidence: { a: 1 } });
	const b = await log.record({ verb: "check", objectRef: "listing:1", evidence: { b: 2 } });
	for (const r of [a, b]) {
		assert.deepEqual(validateReceipt(r), []);
		assert.equal(r.agent_key_id, addressOf(priv).toLowerCase());
		const s = r.signatures[0]!;
		assert.equal(s.alg, "secp256k1");
		assert.equal(s.key_id, addressOf(priv).toLowerCase());
		assert.equal(recoverAddress(receiptDigest(r.hash), Buffer.from(s.sig, "base64url")).toLowerCase(), s.key_id);
	}
	assert.equal(b.prev_hash, a.hash);
});

test("the log's signer refuses anything but a CAS receipt message", async () => {
	const { kc } = memKeychain(keys[1]!);
	const log = agentKeyReceiptLog({ mandateId: "m-1", agentId: "agent-1" }, { keychain: kc, home: home() });
	assert.equal((log as unknown as { signer?: Signer }).signer, undefined, "the signer is a # private field, unreachable from outside");
	const { agentKeySigner } = await import("../src/receiptsigner.ts");
	const signer = agentKeySigner(keys[1]!, home());
	for (const bad of ["hello", "CAS-v0.1\nsha256:" + "A".repeat(64), "CAS-v0.1\n0x" + "1".repeat(64), "\x19Ethereum Signed Message:\n5hello"])
		assert.throws(() => signer(Buffer.from(bad, "utf8")), /refusing to sign/, JSON.stringify(bad));
});

test("the package index does not export the hash-level signer", () => {
	assert.equal("signCasHash" in index, false);
	assert.equal(typeof index.agentKeyReceiptLog, "function");
});

// --- kill file ------------------------------------------------------------------------------

test("kill file: present at creation -> nothing is read or signed; created mid-run -> the next record is refused and not logged", async () => {
	const h1 = home();
	disable(h1);
	const m1 = memKeychain(keys[0]!);
	assert.throws(() => agentKeyReceiptLog({ mandateId: "m-1", agentId: "a" }, { keychain: m1.kc, home: h1 }), DisabledError);
	assert.deepEqual(m1.reads, [], "the keychain is not touched when disabled");
	const h2 = home();
	const log = agentKeyReceiptLog({ mandateId: "m-1", agentId: "a" }, { keychain: memKeychain(keys[0]!).kc, home: h2 });
	await log.record({ verb: "read", objectRef: "x", evidence: 1 });
	disable(h2);
	await assert.rejects(() => log.record({ verb: "read", objectRef: "y", evidence: 2 }), DisabledError);
	assert.equal(log.receipts.length, 1);
});

test("kill file fails closed: a path whose state cannot be read counts as disabled", async () => {
	const h = freshHome();
	writeFileSync(join(h, ".commertize"), "a file where a directory should be"); // lstat of .commertize/DISABLED -> ENOTDIR
	assert.throws(() => agentKeyReceiptLog({ mandateId: "m-1", agentId: "a" }, { keychain: memKeychain(keys[0]!).kc, home: h }), /could not be (checked|set up)/);
	const { assertNotDisabled } = await import("../src/receiptsigner.ts");
	assert.throws(() => assertNotDisabled(h), /could not be checked/);
	// No kill file but never enabled (e.g. the file was deleted by hand): still off.
	const h2 = freshHome();
	mkdirSync(join(h2, ".commertize"), { recursive: true });
	assert.throws(() => assertNotDisabled(h2), /never enabled/);
});

// --- CLI ----------------------------------------------------------------------------------------

async function run(argv: string[], o: { kc?: Keychain; home?: string }) {
	const out: string[] = [];
	const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, { keychain: o.kc, home: o.home ?? home(), signals: false });
	return { code, o: JSON.parse(out.at(-1)!) };
}

test("receipt test-sign: signs one self-test receipt and checks it recovers; exit 19 with the kill file, before the keychain is read", async () => {
	const ok = await run(["receipt", "test-sign"], { kc: memKeychain(keys[2]!).kc });
	assert.equal(ok.code, 0);
	assert.equal(ok.o.data.matches_key_id, true);
	assert.equal(ok.o.data.receipt.signatures[0].key_id, addressOf(keys[2]!).toLowerCase());
	const h = home();
	disable(h);
	const m = memKeychain(keys[2]!);
	const off = await run(["receipt", "test-sign"], { kc: m.kc, home: h });
	assert.equal(off.code, 19);
	assert.equal(off.o.hand_back.reason, "disabled");
	assert.equal(off.o.hand_back.by, "principal");
	assert.deepEqual(m.reads, []);
	const none = await run(["receipt", "test-sign"], { kc: memKeychain().kc });
	assert.equal(none.code, 1);
	assert.match(none.o.error.message, /no agent key stored/);
	for (const argv of [["receipt"], ["receipt", "sign"], ["receipt", "test-sign", "x"]]) assert.equal((await run(argv, { kc: memKeychain().kc })).code, 2, argv.join(" "));
});

test("wallet sign-typed-data still signs nothing, even with an agent key stored", async () => {
	const p = join(mkdtempSync(join(tmpdir(), "kit-k4b-td-")), "td.json");
	writeFileSync(p, JSON.stringify({ types: { EIP712Domain: [], Mail: [] }, primaryType: "Mail", domain: { name: "x" }, message: {} }));
	const r = await run(["wallet", "sign-typed-data", "--file", p], { kc: memKeychain(keys[0]!).kc });
	assert.equal(r.code, 4);
	assert.equal(r.o.data.signed, false);
});

test("runOnce: COMMERTIZE_RECEIPT_SIGNER accepts only ed25519 or agent-key", async () => {
	const { runOnce } = await import("../src/run.ts");
	const t = { name: "t", run: async () => ({ receipts: [], stopped: [], output: [] }) } as unknown as Parameters<typeof runOnce>[0];
	await assert.rejects(() => runOnce(t, async () => "", { COMMERTIZE_RECEIPT_SIGNER: "raw-key" }), /ed25519.*agent-key/);
});

test("signDigest self-checks: a signature that would not recover to the expected address is never returned", async () => {
	const { signDigest } = await import("../src/secp256k1.ts");
	const d = receiptDigest("sha256:" + "1".repeat(64));
	assert.throws(() => signDigest(d, BigInt(keys[0]!), addressOf(keys[1]!)), /self-check failed/);
	assert.equal(signDigest(d, BigInt(keys[0]!), addressOf(keys[0]!)).length, 65);
	assert.throws(() => signDigest(d, 0n, addressOf(keys[0]!)), /out of range/);
	assert.throws(() => signDigest(d, N, addressOf(keys[0]!)), /out of range/);
});

// --- the kill file stops every signer and every write; signing is off by default ---

const SEED = Buffer.alloc(32, 7).toString("base64url");
const ed25519Env = { COMMERTIZE_MANDATE_ID: "m-1", COMMERTIZE_AGENT_ID: "a-1", COMMERTIZE_AGENT_KEY_ID: "k-1", COMMERTIZE_AGENT_SEED: SEED };

function countingFetch() {
	const calls: string[] = [];
	const f = (async (url: string | URL, init?: RequestInit) => {
		calls.push(`${init?.method ?? "GET"} ${String(url)}`);
		return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { f, calls };
}

test("runOnce default (ed25519) mode with the kill file present: refused before the template runs; seed never parsed", async () => {
	const { runOnce } = await import("../src/run.ts");
	const h = home();
	disable(h);
	let ran = false;
	const t = { name: "t", routes: [], run: async () => ((ran = true), { receipts: [], stopped: [], output: [] }) } as unknown as Parameters<typeof runOnce>[0];
	await assert.rejects(() => runOnce(t, async () => "", { ...ed25519Env, COMMERTIZE_AGENT_SEED: "not-a-seed!" }, undefined, { home: h }), DisabledError);
	assert.equal(ran, false);
	const fresh = freshHome();
	await assert.rejects(() => runOnce(t, async () => "", ed25519Env, undefined, { home: fresh }), DisabledError, "a fresh machine is off by default");
	assert.equal(ran, false);
});

test("runOnce agent-key mode with the kill file present: refused before the keychain is read", async () => {
	const { runOnce } = await import("../src/run.ts");
	const h = home();
	disable(h);
	const m = memKeychain(keys[0]!);
	const t = { name: "t", run: async () => ({ receipts: [], stopped: [], output: [] }) } as unknown as Parameters<typeof runOnce>[0];
	await assert.rejects(() => runOnce(t, async () => "", { ...ed25519Env, COMMERTIZE_RECEIPT_SIGNER: "agent-key" }, undefined, { home: h, keychain: m.kc }), DisabledError);
	assert.deepEqual(m.reads, []);
});

test("runOnce: empty COMMERTIZE_RECEIPT_SIGNER says unset it or choose a mode", async () => {
	const { runOnce } = await import("../src/run.ts");
	const t = { name: "t", run: async () => ({ receipts: [], stopped: [], output: [] }) } as unknown as Parameters<typeof runOnce>[0];
	await assert.rejects(() => runOnce(t, async () => "", { ...ed25519Env, COMMERTIZE_RECEIPT_SIGNER: "  " }, undefined, { home: home() }), /unset it, or choose a mode/);
});

test("ed25519 signer inside runOnce: kill file created mid-run refuses the next signature and the next write; reads still pass", async () => {
	const { runOnce } = await import("../src/run.ts");
	const { callOrStop } = await import("../src/kit.ts");
	const { CommertizeClient, readEnv } = await import("../src/client.ts");
	const h = home();
	const { f, calls } = countingFetch();
	const seen: string[] = [];
	const t = {
		name: "t",
		run: async (ctx: Parameters<Parameters<typeof runOnce>[0]["run"]>[0]) => {
			const res = { receipts: [] as unknown[], stopped: [] as unknown[], output: [] as unknown[] };
			res.receipts.push(await ctx.log.record({ verb: "read", objectRef: "x", evidence: 1 }));
			disable(h);
			await assert.rejects(() => ctx.log.record({ verb: "read", objectRef: "y", evidence: 2 }), DisabledError);
			for (const id of ["workSubmit", "sponsorSubmission"] as const) {
				await assert.rejects(() => ctx.client.call(id, { body: {} }), DisabledError, id);
				await assert.rejects(() => callOrStop(ctx, res as never, id, { body: {} }), DisabledError, `callOrStop ${id}`);
			}
			await assert.rejects(() => ctx.client.call("no-such-route" as never), DisabledError, "unknown ids count as writes");
			await ctx.client.call("listings");
			seen.push(...calls);
			return res;
		},
	} as unknown as Parameters<typeof runOnce>[0];
	const res = await runOnce(t, async () => "", ed25519Env, undefined, { home: h, client: new CommertizeClient(readEnv({}), f) });
	assert.equal(res.receipts.length, 1, "nothing recorded after the kill file");
	assert.equal(res.stopped.length, 0, "a kill-file refusal is not a route-missing stop");
	assert.equal(seen.length, 1);
	assert.match(seen[0]!, /^GET /);
	process.exitCode = 0;
});

test("default off: configure creates the kill file; enable-signing needs --confirm and removes it; disable-signing restores it", async () => {
	const h = freshHome();
	const c = await run(["configure"], { kc: memKeychain().kc, home: h });
	assert.equal(c.o.data.signing, "off");
	assert.ok(readdirSync(join(h, ".commertize")).includes("DISABLED"));
	assert.equal((await run(["receipt", "enable-signing"], { home: h })).code, 2);
	assert.ok(readdirSync(join(h, ".commertize")).includes("DISABLED"));
	assert.equal((await run(["receipt", "enable-signing", "--confirm"], { home: h })).code, 0);
	assert.ok(!readdirSync(join(h, ".commertize")).includes("DISABLED"));
	assert.equal((await run(["configure"], { kc: memKeychain().kc, home: h })).o.data.signing, "on", "configure does not re-disable after the person enabled");
	assert.equal((await run(["receipt", "disable-signing"], { home: h })).code, 0);
	assert.ok(readdirSync(join(h, ".commertize")).includes("DISABLED"));
	const off = await run(["receipt", "test-sign"], { kc: memKeychain(keys[0]!).kc, home: h });
	assert.equal(off.code, 19);
	assert.match(off.o.error.message, /receipt enable-signing --confirm/, "the hand-back says how the person enables it");
});

test("kill file + malformed profile -> exit 19, not 1 (the kill file is checked before the profile is read)", async () => {
	const h = home();
	mkdirSync(join(h, ".commertize", "profiles"), { recursive: true, mode: 0o700 });
	writeFileSync(join(h, ".commertize", "profiles", "default.json"), "{not json", { mode: 0o600 });
	disable(h);
	const r = await run(["receipt", "test-sign"], { kc: memKeychain(keys[0]!).kc, home: h });
	assert.equal(r.code, 19);
});

test("test-sign with no active agent warns that receipts cannot verify until the key belongs to an agent", async () => {
	const errs: string[] = [];
	const out: string[] = [];
	const code = await main(["receipt", "test-sign", "--json"], (l) => out.push(l), (l) => errs.push(l), { keychain: memKeychain(keys[1]!).kc, home: home(), signals: false });
	assert.equal(code, 0);
	assert.ok(errs.some((l) => /no active agent.*cannot verify until/.test(l)), errs.join("\n"));
});

test("runMain (template main.ts): kill file -> exit 19 with the hand-back text, not an uncaught exit 1; other errors propagate", async () => {
	const { runMain } = await import("../src/run.ts");
	const t = { name: "t", run: async () => ({ receipts: [], stopped: [], output: [] }) } as unknown as Parameters<typeof runMain>[0];
	const h = home();
	disable(h);
	const errs: string[] = [];
	const prev = process.exitCode;
	assert.equal(await runMain(t, async () => "", ed25519Env, { home: h, errOut: (l) => errs.push(l) }), null);
	assert.equal(process.exitCode, 19);
	process.exitCode = prev;
	assert.match(errs.join("\n"), /receipt enable-signing --confirm/);
	await assert.rejects(() => runMain(t, async () => "", { ...ed25519Env, COMMERTIZE_RECEIPT_SIGNER: "raw-key" }, { home: home() }), /ed25519.*agent-key/);
});

test("every template main.ts enters through runMain, so a stopped run exits 19", () => {
	const root = fileURLToPath(new URL("../../../templates/", import.meta.url));
	const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	assert.ok(dirs.length >= 4);
	for (const d of dirs) {
		const src = readFileSync(join(root, d, "main.ts"), "utf8");
		assert.match(src, /await runMain\(/, d);
		assert.doesNotMatch(src, /runOnce/, d);
	}
});
