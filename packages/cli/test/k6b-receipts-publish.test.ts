// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-6b: one signed CAS receipt per settled serve call (existing receipt signer path, off by default), and service publish (Not open).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressOf, AGENT_KEY } from "../src/agentkey.ts";
import { signDigest, recoverAddress } from "../src/secp256k1.ts";
import { checkSequence, recordHash, sha256, validateReceipt, type Receipt } from "../src/cas.ts";
import { agentKeyReceiptLog, disableSigning, enableSigning, receiptDigest } from "../src/receiptsigner.ts";
import { checkValue, type Keychain, type KeyName } from "../src/keychain.ts";
import { OperatorSeller, parseServeConfig, serveKillFilePath, transferAuthorizationDigest, type Authorization } from "../src/seller.ts";
import { serveEvidence, serveReceiptHook } from "../src/servereceipt.ts";
import { main } from "../src/cli.ts";

const AGENT_PRIV = "0x" + "3".repeat(63) + "1";
const PAYER_KEY = "0x" + "1".repeat(63) + "7";
const PAY_TO = "0x" + "b".repeat(40);
const NOW_MS = 1_800_000_000_000;
const TX = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const CFG_RAW = () => ({
	schema: "commertize.serve/v1",
	serviceId: "",
	endpoint: { path: "/v1/call", publicUrl: "https://agent.example.com" },
	pricing: { currency: "USDC", pricePerCall: "0.05", network: "eip155:84532" },
});
const CFG = parseServeConfig(CFG_RAW());
const IDS = { mandateId: "mdt_1", agentId: "agt_1" };

function memKeychain(): Keychain {
	const store = new Map<KeyName, string>([[AGENT_KEY as KeyName, AGENT_PRIV]]);
	return {
		available: () => true,
		has: (n) => store.has(n),
		get: (n) => store.get(n),
		set: (n, v) => void store.set(n, checkValue(v)),
		clear: (n) => store.delete(n),
		add: () => "exists",
	};
}

let nonceN = 0;
function payment(): string {
	const auth: Authorization = { from: addressOf(PAYER_KEY), to: PAY_TO, value: CFG.priceBase.toString(), validAfter: "0", validBefore: String(NOW_MS / 1000 + 120), nonce: "0x" + (++nonceN).toString(16).padStart(64, "0") };
	const sig = signDigest(transferAuthorizationDigest(CFG.usdc, auth), BigInt(PAYER_KEY), auth.from);
	const accepted = { scheme: "exact", network: CFG.usdc.network, amount: auth.value, asset: CFG.usdc.asset, payTo: PAY_TO };
	return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x" + sig.toString("hex"), authorization: auth } })).toString("base64");
}

function setup(o: { settle?: () => { success: boolean; transaction?: string; errorReason?: string }; handler?: () => Promise<unknown> } = {}) {
	const home = mkdtempSync(join(tmpdir(), "kit-k6b-home-"));
	enableSigning(home);
	const log = agentKeyReceiptLog(IDS, { keychain: memKeychain(), home, now: () => new Date(NOW_MS) });
	const issued: Receipt[] = [];
	let tx = 0;
	const s = new OperatorSeller({
		config: CFG,
		payTo: PAY_TO,
		facilitator: { verify: async () => ({ isValid: true }), settle: async () => (o.settle ? o.settle() : { success: true, transaction: TX(++tx) }) },
		screen: async () => "clear",
		assertEnabled: () => {},
		handler: o.handler ?? (async (input) => ({ answer: input })),
		now: () => NOW_MS,
		onSettled: serveReceiptHook(log, { serviceId: "svc_1", payTo: PAY_TO, network: CFG.usdc.network }, (r) => issued.push(r)),
	});
	return { s, log, issued, home };
}

const BODY = Buffer.from(JSON.stringify({ q: "x" }));

test("receipt: exactly one per settled call; the chain links; each is valid and signed by the agent key", async () => {
	const { s, issued } = setup();
	const rs = [await s.handle({ "payment-signature": payment() }, BODY), await s.handle({ "payment-signature": payment() }, BODY)];
	assert.deepEqual(rs.map((r) => r.status), [200, 200]);
	assert.equal(issued.length, 2);
	assert.equal(rs[0]!.headers["X-Commertize-Receipt"], issued[0]!.receipt_id);
	assert.equal(rs[1]!.headers["X-Commertize-Receipt-Hash"], issued[1]!.hash);
	assert.equal(issued[1]!.prev_hash, issued[0]!.hash);
	assert.equal(checkSequence(issued), null);
	for (const r of issued) {
		assert.deepEqual(validateReceipt(r), []);
		const { hash, signatures, ...body } = r;
		assert.equal(recordHash(body), hash);
		const sig = Buffer.from(signatures[0]!.sig, "base64url");
		assert.equal(recoverAddress(receiptDigest(hash), sig).toLowerCase(), addressOf(AGENT_PRIV).toLowerCase());
	}
});

test("receipt: request and response hashes recompute from the bytes; the evidence hash rebuilds from the call", async () => {
	const { s, issued } = setup();
	const r = await s.handle({ "payment-signature": payment() }, BODY);
	const rec = issued[0]!;
	assert.deepEqual(rec.evidence.refs, [sha256(BODY), sha256(r.body)]);
	assert.equal(rec.action.verb, "file");
	assert.equal(rec.action.object_ref, `eip155:84532:${TX(1)}`);
	const ev = serveEvidence({ serviceId: "svc_1", payTo: PAY_TO, network: "eip155:84532" }, { payer: addressOf(PAYER_KEY), amount: CFG.priceBase, transaction: TX(1), requestBody: BODY, responseBody: r.body });
	assert.equal(rec.evidence.sha256, sha256(JSON.stringify(ev)));
	assert.equal(ev.amount, "50000");
	assert.doesNotMatch(JSON.stringify(rec), /"q"|answer/, "no body in the receipt");
});

test("receipt: none when settle fails or the handler fails (no money moved)", async () => {
	const a = setup({ settle: () => ({ success: false, errorReason: "insufficient_funds" }) });
	assert.equal((await a.s.handle({ "payment-signature": payment() }, BODY)).status, 502);
	assert.equal(a.issued.length, 0);
	const b = setup({ handler: async () => { throw new Error("x"); } });
	assert.equal((await b.s.handle({ "payment-signature": payment() }, BODY)).status, 502);
	assert.equal(b.issued.length, 0);
});

test("receipt: signing turned off mid-run: the settled call is answered, the receipt is marked none, and nothing is signed", async () => {
	const { s, issued, home } = setup();
	disableSigning(home);
	const r = await s.handle({ "payment-signature": payment() }, BODY);
	assert.equal(r.status, 200);
	assert.equal(r.headers["X-Commertize-Receipt"], "none");
	assert.equal(issued.length, 0);
});

test("receipt log: refused to build while signing is off by default (never enabled)", () => {
	const home = mkdtempSync(join(tmpdir(), "kit-k6b-home-"));
	assert.throws(() => agentKeyReceiptLog(IDS, { keychain: memKeychain(), home }), /never enabled|DISABLED exists/);
});

// --- service publish ----------------------------------------------------------------------------

async function runCli(argv: string[], home: string) {
	const out: string[] = [];
	let built = 0;
	const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, {
		home,
		signals: false,
		client: () => {
			built++;
			throw new Error("no client may be built");
		},
	});
	return { code, o: JSON.parse(out.at(-1)!), built };
}

test("service publish: kill file first, then the config, then Not open (exit 4); no client is built", async () => {
	const home = mkdtempSync(join(tmpdir(), "kit-k6b-home-"));
	const p = join(home, "commertize.serve.json");
	let r = await runCli(["service", "publish", "--config", join(home, "absent.json")], home);
	assert.equal(r.code, 19);
	enableSigning(home);
	writeFileSync(p, JSON.stringify({ ...CFG_RAW(), pricing: { currency: "USDC", pricePerCall: "2", network: "eip155:84532" } }));
	r = await runCli(["service", "publish", "--config", p], home);
	assert.equal(r.code, 1);
	assert.match(r.o.error.message, /Tier 0 per-call cap/);
	writeFileSync(p, JSON.stringify(CFG_RAW()));
	r = await runCli(["service", "publish", "--config", p], home);
	assert.equal(r.code, 4);
	assert.equal(r.o.error.code, "route_missing");
	assert.match(r.o.error.message, /\/v1\/directory\/services/);
	assert.equal(r.built, 0);
});

test("service publish: the serve kill file stops it too (exit 19), before the config is read", async () => {
	const home = mkdtempSync(join(tmpdir(), "kit-k6b-home-"));
	enableSigning(home);
	mkdirSync(join(home, ".commertize", "serve"), { recursive: true });
	writeFileSync(serveKillFilePath(home), "off\n");
	const r = await runCli(["service", "publish", "--config", join(home, "absent.json")], home);
	assert.equal(r.code, 19);
	assert.equal(r.o.hand_back.reason, "disabled");
	assert.equal(r.built, 0);
});

test("service: unpublish and show are Not open (exit 4); an unknown subcommand is a usage error", async () => {
	const home = mkdtempSync(join(tmpdir(), "kit-k6b-home-"));
	enableSigning(home);
	for (const sub of ["unpublish", "show"]) assert.equal((await runCli(["service", sub], home)).code, 4, sub);
	assert.equal((await runCli(["service", "deploy"], home)).code, 2);
});
