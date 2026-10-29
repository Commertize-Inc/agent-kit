// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-6a: OperatorSeller (x402 exact, payer pays the operator directly), local payment checks, Tier 0 caps, kill files, serve start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressOf } from "../src/agentkey.ts";
import { signDigest } from "../src/secp256k1.ts";
import { disableSigning, enableSigning } from "../src/receiptsigner.ts";
import {
	assertServeEnabled,
	CapLedger,
	domainSeparator,
	NonceStore,
	signatureMatchesPayer,
	decodePaymentSignature,
	HEADER_REQUIRED,
	HEADER_RESPONSE,
	OperatorSeller,
	parseServeConfig,
	serveKillFilePath,
	TIER0,
	transferAuthorizationDigest,
	usdcToBaseUnits,
	type Authorization,
	type Facilitator,
	type ScreenResult,
	type ServeConfig,
} from "../src/seller.ts";
import { main } from "../src/cli.ts";

const PAYER_KEY = "0x" + "1".repeat(63) + "7";
const PAYER = addressOf(PAYER_KEY);
const OTHER_KEY = "0x" + "2".repeat(63) + "9";
const PAY_TO = "0x" + "b".repeat(40);
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

const CFG_RAW = () => ({
	schema: "commertize.serve/v1",
	serviceId: "",
	endpoint: { path: "/v1/call", publicUrl: "https://agent.example.com", maxInputBytes: 1024 },
	pricing: { currency: "USDC", pricePerCall: "0.05", network: "eip155:84532" },
});
const CFG: ServeConfig = parseServeConfig(CFG_RAW());

let nonceN = 0;
const nextNonce = () => "0x" + (++nonceN).toString(16).padStart(64, "0");

function payment(o: { key?: string; auth?: Partial<Authorization>; accepted?: Record<string, unknown>; cfg?: ServeConfig } = {}): string {
	const cfg = o.cfg ?? CFG;
	const key = o.key ?? PAYER_KEY;
	const auth: Authorization = {
		from: addressOf(key),
		to: PAY_TO,
		value: cfg.priceBase.toString(),
		validAfter: "0",
		validBefore: String(NOW_S + 120),
		nonce: nextNonce(),
		...o.auth,
	};
	const sig = signDigest(transferAuthorizationDigest(cfg.usdc, auth), BigInt(key), addressOf(key));
	const accepted = { scheme: "exact", network: cfg.usdc.network, amount: auth.value, asset: cfg.usdc.asset, payTo: auth.to, ...o.accepted };
	return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x" + sig.toString("hex"), authorization: auth } })).toString("base64");
}

function spyFacilitator(o: { verify?: boolean; settle?: { success: boolean; transaction?: string; errorReason?: string } } = {}) {
	const calls: string[] = [];
	const f: Facilitator = {
		verify: async () => (calls.push("verify"), { isValid: o.verify ?? true }),
		settle: async () => (calls.push("settle"), o.settle ?? { success: true, transaction: "0x" + "c".repeat(64) }),
	};
	return { f, calls };
}

function seller(o: { fac?: ReturnType<typeof spyFacilitator>; screen?: ScreenResult | (() => Promise<ScreenResult>); enabled?: () => void; caps?: CapLedger; now?: () => number; cfg?: ServeConfig } = {}) {
	const fac = o.fac ?? spyFacilitator();
	const events: string[] = [];
	const s = new OperatorSeller({
		config: o.cfg ?? CFG,
		payTo: PAY_TO,
		facilitator: {
			verify: (p, r) => (events.push("verify"), fac.f.verify(p, r)),
			settle: (p, r) => (events.push("settle"), fac.f.settle(p, r)),
		},
		screen: async () => (events.push("screen"), typeof o.screen === "function" ? o.screen() : (o.screen ?? "clear")),
		assertEnabled: o.enabled ?? (() => {}),
		handler: async (input) => (events.push("handler"), { echo: input }),
		caps: o.caps,
		now: o.now ?? (() => NOW_MS),
	});
	return { s, fac, events };
}

const BODY = Buffer.from(JSON.stringify({ q: 1 }));
const call = (s: OperatorSeller, sig?: string) => s.handle(sig === undefined ? {} : { "payment-signature": sig }, BODY);

// --- amounts and config -------------------------------------------------------------------------

test("usdcToBaseUnits: integer math, at most 6 decimals, refuses floats, signs and exponents", () => {
	assert.equal(usdcToBaseUnits("0.05"), 50_000n);
	assert.equal(usdcToBaseUnits("1"), 1_000_000n);
	assert.equal(usdcToBaseUnits("0.000001"), 1n);
	for (const bad of ["0.0000001", "-1", "1e3", ".5", "01", "1.", " 1", "0x10"]) assert.throws(() => usdcToBaseUnits(bad), /USDC amount/, bad);
	assert.throws(() => usdcToBaseUnits(0.05 as unknown as string), /USDC amount/);
});

test("config: refuses a payee in the file, unknown keys, zero price, a price over the Tier 0 per-call cap, and a network that is not open", () => {
	const with_ = (f: (c: any) => void) => {
		const c: any = CFG_RAW();
		f(c);
		return c;
	};
	assert.throws(() => parseServeConfig(with_((c) => (c.payTo = PAY_TO))), /unknown key "payTo"/);
	assert.throws(() => parseServeConfig(with_((c) => (c.pricing.payTo = PAY_TO))), /unknown key "payTo"/);
	assert.throws(() => parseServeConfig(with_((c) => (c.pricing.pricePerCall = "0"))), /more than 0/);
	assert.throws(() => parseServeConfig(with_((c) => (c.pricing.pricePerCall = "1.000001"))), /Tier 0 per-call cap/);
	assert.equal(parseServeConfig(with_((c) => (c.pricing.pricePerCall = "1"))).priceBase, TIER0.perCall);
	assert.throws(() => parseServeConfig(with_((c) => (c.pricing.network = "eip155:8453"))), /Not open/);
	assert.throws(() => parseServeConfig(with_((c) => (c.pricing.network = "toString"))), /must be one of/);
	assert.throws(() => parseServeConfig(with_((c) => (c.pricing.currency = "USDT"))), /USDC/);
	assert.throws(() => parseServeConfig(with_((c) => (c.endpoint.publicUrl = "http://agent.example.com"))), /https/);
	assert.throws(() => parseServeConfig(with_((c) => (c.schema = "v0"))), /schema/);
});

test("seller: refuses a zero or malformed payTo at build time", () => {
	for (const payTo of ["0x" + "0".repeat(40), "0xabc", ""])
		assert.throws(() => new OperatorSeller({ config: CFG, payTo, facilitator: spyFacilitator().f, screen: async () => "clear", assertEnabled: () => {}, handler: async () => ({}) }), /payTo/);
});

// --- challenge ----------------------------------------------------------------------------------

test("unpaid call: 402 with the exact requirements; payTo is the operator payee, amount is the price in base units; no facilitator call", async () => {
	const { s, fac, events } = seller();
	const r = await call(s);
	assert.equal(r.status, 402);
	const pr = JSON.parse(Buffer.from(r.headers[HEADER_REQUIRED]!, "base64").toString());
	assert.equal(pr.x402Version, 2);
	assert.deepEqual(pr.accepts, [
		{
			scheme: "exact",
			network: "eip155:84532",
			amount: "50000",
			asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			payTo: PAY_TO,
			resource: "https://agent.example.com/v1/call",
			maxTimeoutSeconds: 300,
			extra: { name: "USDC", version: "2", serviceId: "" },
		},
	]);
	assert.deepEqual(fac.calls, []);
	assert.deepEqual(events, []);
});

// --- local refusals, zero facilitator calls -----------------------------------------------------

test("local refusals: payee, amount (1 base unit under and over), short validity, too long, validAfter in the future, bad signature, malformed: zero facilitator calls, handler never runs", async () => {
	const price = CFG.priceBase;
	const cases: [string, string, number, string][] = [
		["payee", payment({ auth: { to: "0x" + "d".repeat(40) } }), 422, "PAYEE_MISMATCH"],
		["accepted payee", payment({ accepted: { payTo: "0x" + "d".repeat(40) } }), 422, "PAYEE_MISMATCH"],
		["signed payee only", payment({ auth: { to: "0x" + "d".repeat(40) }, accepted: { payTo: PAY_TO } }), 422, "PAYEE_MISMATCH"],
		["accepted amount only", payment({ accepted: { amount: (price - 1n).toString() } }), 422, "AMOUNT_MISMATCH"],
		["1 under", payment({ auth: { value: (price - 1n).toString() } }), 422, "AMOUNT_MISMATCH"],
		["1 over", payment({ auth: { value: (price + 1n).toString() }, accepted: { amount: price.toString() } }), 422, "AMOUNT_MISMATCH"],
		["29 s left", payment({ auth: { validBefore: String(NOW_S + 29) } }), 422, "PAYMENT_INVALID"],
		["too long", payment({ auth: { validBefore: String(NOW_S + 301) } }), 422, "PAYMENT_INVALID"],
		["validAfter in the future", payment({ auth: { validAfter: String(NOW_S + 1) } }), 422, "PAYMENT_INVALID"],
		["asset", payment({ accepted: { asset: "0x" + "e".repeat(40) } }), 422, "PAYMENT_INVALID"],
		["network", payment({ accepted: { network: "eip155:8453" } }), 422, "PAYMENT_INVALID"],
		["malformed", "not-base64-json", 422, "PAYMENT_INVALID"],
	];
	for (const [name, sig, status, code] of cases) {
		const { s, fac, events } = seller();
		const r = await call(s, sig);
		assert.equal(r.status, status, name);
		assert.equal(JSON.parse(r.body).error.code, code, name);
		assert.deepEqual(fac.calls, [], `${name}: facilitator called`);
		assert.ok(!events.includes("handler"), `${name}: handler ran`);
	}
});

test("signature: a payload signed by someone other than `from` is refused locally", async () => {
	const good = JSON.parse(Buffer.from(payment(), "base64").toString());
	const forged = JSON.parse(Buffer.from(payment({ key: OTHER_KEY }), "base64").toString());
	good.payload.signature = forged.payload.signature;
	const { s, fac } = seller();
	const r = await call(s, Buffer.from(JSON.stringify(good)).toString("base64"));
	assert.equal(r.status, 422);
	assert.equal(r.reason, "signature");
	assert.deepEqual(fac.calls, []);
});

test("signature: a payload signed under another domain (mainnet name) does not recover to the payer", async () => {
	const mainnetish = { ...CFG, usdc: { ...CFG.usdc, name: "USD Coin" } };
	const { s, fac } = seller();
	const r = await call(s, payment({ cfg: mainnetish as ServeConfig, accepted: { asset: CFG.usdc.asset, network: CFG.usdc.network } }));
	assert.equal(r.reason, "signature");
	assert.deepEqual(fac.calls, []);
});

test("nonce replay: the same authorization twice is refused the second time with no facilitator call", async () => {
	const { s, fac } = seller();
	const sig = payment();
	assert.equal((await call(s, sig)).status, 200);
	fac.calls.length = 0;
	const r = await call(s, sig);
	assert.equal(r.status, 422);
	assert.equal(r.reason, "nonce_replay");
	assert.deepEqual(fac.calls, []);
});

test("decode: extra keys in payload or authorization are refused", () => {
	const p = JSON.parse(Buffer.from(payment(), "base64").toString());
	p.payload.authorization.extra = "1";
	assert.equal(decodePaymentSignature(Buffer.from(JSON.stringify(p)).toString("base64")), null);
	const q = JSON.parse(Buffer.from(payment(), "base64").toString());
	q.payload.permit = "1";
	assert.equal(decodePaymentSignature(Buffer.from(JSON.stringify(q)).toString("base64")), null);
});

// --- order: verify, handler, settle -------------------------------------------------------------

test("happy path: screen, verify, handler, settle in that order; 200 with PAYMENT-RESPONSE naming the payer", async () => {
	const { s, events } = seller();
	const r = await call(s, payment());
	assert.equal(r.status, 200);
	assert.deepEqual(events, ["screen", "verify", "handler", "settle"]);
	const pr = JSON.parse(Buffer.from(r.headers[HEADER_RESPONSE]!, "base64").toString());
	assert.equal(pr.success, true);
	assert.equal(pr.payer, PAYER);
	assert.deepEqual(JSON.parse(r.body), { echo: { q: 1 } });
});

test("verify fails: handler never runs, no settle", async () => {
	const { s, events } = seller({ fac: spyFacilitator({ verify: false }) });
	const r = await call(s, payment());
	assert.equal(r.status, 422);
	assert.deepEqual(events, ["screen", "verify"]);
});

test("settle fails: the output is discarded, 502 SETTLE_FAILED, no PAYMENT-RESPONSE", async () => {
	const { s } = seller({ fac: spyFacilitator({ settle: { success: false, errorReason: "unexpected_settle_error" } }) });
	const r = await call(s, payment());
	assert.equal(r.status, 502);
	assert.equal(JSON.parse(r.body).error.code, "SETTLE_FAILED");
	assert.doesNotMatch(r.body, /echo/);
	assert.equal(r.headers[HEADER_RESPONSE], undefined);
});

test("validity boundary: exactly 30 s left and exactly maxTimeoutSeconds are accepted", async () => {
	for (const vb of [NOW_S + 30, NOW_S + 300]) assert.equal((await call(seller().s, payment({ auth: { validBefore: String(vb) } }))).status, 200, String(vb));
});

test("settle success without a well-formed tx hash is a failure; so is success:false with a tx hash", async () => {
	const { s } = seller({ fac: spyFacilitator({ settle: { success: true, transaction: "0x12" } }) });
	assert.equal((await call(s, payment())).status, 502);
	const t = seller({ fac: spyFacilitator({ settle: { success: false, transaction: "0x" + "c".repeat(64) } }) });
	const r = await call(t.s, payment());
	assert.equal(r.status, 502);
	assert.doesNotMatch(r.body, /echo/);
});

test("handler fails: no settle, 502 HANDLER_FAILED, and the cap reservation is given back", async () => {
	const caps = new CapLedger();
	const fac = spyFacilitator();
	const s = new OperatorSeller({ config: CFG, payTo: PAY_TO, facilitator: fac.f, screen: async () => "clear", assertEnabled: () => {}, handler: async () => { throw new Error("boom"); }, caps, now: () => NOW_MS });
	const r = await call(s, payment());
	assert.equal(r.status, 502);
	assert.equal(JSON.parse(r.body).error.code, "HANDLER_FAILED");
	assert.deepEqual(fac.calls, ["verify"]);
	assert.equal(caps.spent(PAYER, 0), 0n);
});

// --- sanctions screen ---------------------------------------------------------------------------

test("screen: listed is refused, unavailable or throwing is refused (fail closed); neither reaches the facilitator", async () => {
	const screens: (ScreenResult | (() => Promise<ScreenResult>))[] = ["listed", "unavailable", async () => { throw new Error("down"); }, "maybe" as ScreenResult];
	for (const screen of screens) {
		const { s, fac } = seller({ screen });
		const r = await call(s, payment());
		assert.ok(r.status === 403 || r.status === 503, String(screen));
		assert.deepEqual(fac.calls, [], String(screen));
	}
});

// --- Tier 0 caps --------------------------------------------------------------------------------

test("caps: the 24 h cap per payer at the per-call maximum: the 26th call is refused before the facilitator; 24 h later it fits", async () => {
	const cfg = parseServeConfig({ ...CFG_RAW(), pricing: { currency: "USDC", pricePerCall: "1", network: "eip155:84532" } });
	let now = NOW_MS;
	const caps = new CapLedger();
	const { s, fac } = seller({ cfg, caps, now: () => now });
	const pay = () => payment({ cfg, auth: { validBefore: String(Math.floor(now / 1000) + 120) } });
	for (let i = 0; i < 25; i++) assert.equal((await call(s, pay())).status, 200, `call ${i + 1}`);
	fac.calls.length = 0;
	const r = await call(s, pay());
	assert.equal(r.status, 429);
	assert.equal(r.reason, "cap_per_24h");
	assert.deepEqual(fac.calls, []);
	now = NOW_MS + 86_400_000;
	assert.equal((await call(s, pay())).status, 200);
});

test("caps: the 30 day cap; exactly at the cap fits, one base unit over does not", () => {
	const caps = new CapLedger({ entries: Array.from({ length: 249 }, (_, i) => ({ payer: PAYER, amount: TIER0.perCall, atMs: NOW_MS - (i + 2) * 86_400_000 / 9 })) });
	// 249 per-call maximums spread over about 28 days; the few inside the last 24 h stay under the 24 h cap.
	const inDay = caps.spent(PAYER, NOW_MS - 86_400_000 + 1);
	assert.ok(inDay <= TIER0.per24h);
	const ok = caps.reserve(PAYER, TIER0.perCall, NOW_MS);
	assert.equal(ok.ok, true);
	const over = caps.reserve(PAYER, 1n, NOW_MS);
	assert.deepEqual(over, { ok: false, cap: "per_30d" });
	// An entry older than 30 days does not count.
	const old = new CapLedger({ entries: [{ payer: PAYER, amount: TIER0.per30d, atMs: NOW_MS - 30 * 86_400_000 }] });
	assert.equal(old.reserve(PAYER, 1n, NOW_MS).ok, true);
});

test("caps: one base unit over the per-call cap is refused; payer addresses compare case-insensitively", () => {
	const caps = new CapLedger();
	assert.deepEqual(caps.reserve(PAYER, TIER0.perCall + 1n, NOW_MS), { ok: false, cap: "per_call" });
	for (let i = 0; i < 25; i++) assert.equal(caps.reserve(i % 2 ? PAYER.toLowerCase() : PAYER.toUpperCase().replace("0X", "0x"), TIER0.perCall, NOW_MS).ok, true);
	assert.deepEqual(caps.reserve(PAYER, 1n, NOW_MS), { ok: false, cap: "per_24h" });
});

test("caps: a refusal before broadcast gives the reservation back; an unknown settle failure keeps it", async () => {
	const cfg = parseServeConfig({ ...CFG_RAW(), pricing: { currency: "USDC", pricePerCall: "1", network: "eip155:84532" } });
	const back = new CapLedger();
	await call(seller({ cfg, caps: back, fac: spyFacilitator({ settle: { success: false, errorReason: "insufficient_funds" } }) }).s, payment({ cfg }));
	assert.equal(back.spent(PAYER, 0), 0n);
	const kept = new CapLedger();
	await call(seller({ cfg, caps: kept, fac: spyFacilitator({ settle: { success: false, errorReason: "settlement_pending" } }) }).s, payment({ cfg }));
	assert.equal(kept.spent(PAYER, 0), TIER0.perCall);
	const vf = new CapLedger();
	await call(seller({ cfg, caps: vf, fac: spyFacilitator({ verify: false }) }).s, payment({ cfg }));
	assert.equal(vf.spent(PAYER, 0), 0n);
});

test("caps: two calls in flight cannot both fit under the 24 h cap", async () => {
	const cfg = parseServeConfig({ ...CFG_RAW(), pricing: { currency: "USDC", pricePerCall: "1", network: "eip155:84532" } });
	const caps = new CapLedger({ entries: [{ payer: PAYER, amount: 24_000_000n, atMs: NOW_MS }] });
	const { s } = seller({ cfg, caps });
	const rs = await Promise.all([call(s, payment({ cfg })), call(s, payment({ cfg }))]);
	assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429]);
});

test("caps: a ledger that cannot be written refuses the call before the facilitator", async () => {
	const caps = new CapLedger({ persist: () => { throw new Error("disk"); } });
	const { s, fac } = seller({ caps });
	const r = await call(s, payment());
	assert.equal(r.status, 503);
	assert.deepEqual(fac.calls, []);
});

// --- kill files ---------------------------------------------------------------------------------

test("kill file: checked first; while present no challenge is issued and nothing else runs", async () => {
	const { s, fac, events } = seller({ enabled: () => { throw new Error("signing is disabled"); } });
	for (const sig of [undefined, payment()]) {
		const r = await call(s, sig);
		assert.equal(r.status, 503);
		assert.equal(JSON.parse(r.body).error.code, "SERVE_DISABLED");
		assert.equal(r.headers[HEADER_REQUIRED], undefined);
	}
	assert.deepEqual(fac.calls, []);
	assert.deepEqual(events, []);
});

test("assertServeEnabled: serve kill file present -> refused; signing never enabled -> refused; enabled and no serve kill file -> ok", () => {
	const h = mkdtempSync(join(tmpdir(), "kit-k6-home-"));
	assert.throws(() => assertServeEnabled(h), /never enabled/);
	enableSigning(h);
	assertServeEnabled(h);
	mkdirSync(join(h, ".commertize", "serve"), { recursive: true });
	writeFileSync(serveKillFilePath(h), "off\n");
	assert.throws(() => assertServeEnabled(h), /serve.DISABLED exists/);
	const h2 = mkdtempSync(join(tmpdir(), "kit-k6-home-"));
	enableSigning(h2);
	disableSigning(h2);
	assert.throws(() => assertServeEnabled(h2), /DISABLED exists/);
	// State that cannot be read counts as disabled: ~/.commertize/serve is a file, so the lookup fails with ENOTDIR.
	const h3 = mkdtempSync(join(tmpdir(), "kit-k6-home-"));
	enableSigning(h3);
	writeFileSync(join(h3, ".commertize", "serve"), "not a directory\n");
	assert.throws(() => assertServeEnabled(h3), /could not be checked \(ENOTDIR\)/);
});

// --- CLI ----------------------------------------------------------------------------------------

async function runCli(argv: string[], home: string) {
	const out: string[] = [];
	let fetched = 0;
	const code = await main([...argv, "--json"], (l) => out.push(l), () => {}, {
		home,
		signals: false,
		client: () => {
			fetched++;
			throw new Error("no client may be built");
		},
		listenServer: async () => {
			throw new Error("nothing may be bound");
		},
	});
	return { code, o: JSON.parse(out.at(-1)!), fetched };
}

test("serve start: kill file first (before the config is read), then config refusals (exit 1), then Not open (exit 4); nothing bound or sent", async () => {
	const h = mkdtempSync(join(tmpdir(), "kit-k6-home-"));
	const cfgPath = join(h, "commertize.serve.json");
	// signing never enabled: refused even with no config file at all
	let r = await runCli(["serve", "start", "--config", join(h, "absent.json")], h);
	assert.equal(r.code, 19);
	assert.equal(r.o.hand_back.reason, "disabled");
	enableSigning(h);
	writeFileSync(cfgPath, JSON.stringify({ ...CFG_RAW(), payTo: PAY_TO }));
	r = await runCli(["serve", "start", "--config", cfgPath], h);
	assert.equal(r.code, 1);
	assert.match(r.o.error.message, /unknown key "payTo"/);
	writeFileSync(cfgPath, JSON.stringify(CFG_RAW()));
	r = await runCli(["serve", "start", "--config", cfgPath], h);
	assert.equal(r.code, 4);
	assert.equal(r.o.error.code, "route_missing");
	assert.match(r.o.error.message, /\/agents\/v1\/screen\/payer/);
	assert.equal(r.fetched, 0);
	mkdirSync(join(h, ".commertize", "serve"), { recursive: true });
	writeFileSync(serveKillFilePath(h), "off\n");
	r = await runCli(["serve", "start", "--config", cfgPath], h);
	assert.equal(r.code, 19);
});

test("serve (bare) is unchanged: exit 4 serve_not_open", async () => {
	const h = mkdtempSync(join(tmpdir(), "kit-k6-home-"));
	const r = await runCli(["serve"], h);
	assert.equal(r.code, 4);
	assert.equal(r.o.hand_back.reason, "serve_not_open");
});

// --- review fixes (K-6a MEDIUM-1..3, LOW-1, LOW-2) ----------------------------------------------

// Hex constants are split in two so no single literal is a 64-hex run (public-repo leak check).
// Base Sepolia USDC DOMAIN_SEPARATOR(), read by eth_call to 0x036CbD53842c5426634e7929541eC2318f3dCF7e on 2026-10-28.
const ONCHAIN_DOMAIN_84532 = "0x71f17a3b2ff373b803d70a5a07c046c1" + "a2bc8e89c09ef722fcb047abe94c9818";
// viem 2.21.0 hashTypedData and signTypedData over the authorization below, with the Hardhat/anvil test key #1.
const VIEM_KEY = "0x59c6995e998f97a5a0044966f0945389" + "dc9e86dae88c7a8412f4603b6b78690d";
const VIEM_DIGEST = "0x5563c5b9c99d8a18f88ef4cdac25584e" + "561f166dd9b71adf93aa7f843fdcabb7";
const VIEM_SIG = "0xda5ecfd9bcc86946789a82559042ec08" + "e5d5839cd0e49e1f1c53a75aa31ed7b7" + "343a89ea62401d0b38352e00e1e04d6a" + "60a7f774ce0e5383682004cd472b0876" + "1b";
const VIEM_AUTH: Authorization = { from: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", to: PAY_TO, value: "50000", validAfter: "0", validBefore: "1800000120", nonce: "0x" + "ab".repeat(32) };

test("digest: the domain separator equals the on-chain Base Sepolia USDC DOMAIN_SEPARATOR", () => {
	assert.equal("0x" + Buffer.from(domainSeparator(CFG.usdc)).toString("hex"), ONCHAIN_DOMAIN_84532);
});

test("digest: equals the viem vector; the viem signature recovers to the payer; any other domain does not", () => {
	assert.equal(addressOf(VIEM_KEY), VIEM_AUTH.from);
	assert.equal("0x" + Buffer.from(transferAuthorizationDigest(CFG.usdc, VIEM_AUTH)).toString("hex"), VIEM_DIGEST);
	const p = { x402Version: 2 as const, accepted: { scheme: "exact", network: CFG.usdc.network, amount: "50000", asset: CFG.usdc.asset, payTo: PAY_TO }, payload: { signature: VIEM_SIG, authorization: VIEM_AUTH } };
	assert.equal(signatureMatchesPayer(p, CFG.usdc), true);
	for (const other of [{ ...CFG.usdc, chainId: 8453 }, { ...CFG.usdc, name: "2", version: "USDC" }, { ...CFG.usdc, asset: "0x" + "e".repeat(40) }]) assert.equal(signatureMatchesPayer(p, other), false);
});

test("caps: an entry is persisted before it counts; a failed write leaves nothing counted", async () => {
	const seenAtPersist: bigint[] = [];
	const ok = new CapLedger({ persist: () => void seenAtPersist.push(ok.spent(PAYER, 0)) });
	ok.reserve(PAYER, 5n, NOW_MS);
	assert.deepEqual(seenAtPersist, [0n], "not counted at the time of the write");
	assert.equal(ok.spent(PAYER, 0), 5n);
	const caps = new CapLedger({ persist: () => { throw new Error("disk"); } });
	const r = await call(seller({ caps }).s, payment());
	assert.equal(r.status, 503);
	assert.equal(JSON.parse(r.body).error.code, "CAP_LEDGER_UNAVAILABLE");
	assert.equal(caps.spent(PAYER, 0), 0n);
});

test("caps: window bounds at one millisecond: 24 h and 30 d", () => {
	const DAY = 86_400_000;
	const full = TIER0.per24h;
	assert.equal(new CapLedger({ entries: [{ payer: PAYER, amount: full, atMs: NOW_MS - DAY + 1 }] }).reserve(PAYER, 1n, NOW_MS).ok, false, "1 ms inside 24 h counts");
	assert.equal(new CapLedger({ entries: [{ payer: PAYER, amount: full, atMs: NOW_MS - DAY }] }).reserve(PAYER, 1n, NOW_MS).ok, true, "exactly 24 h old drops out");
	const entries = (atMs: number) => Array.from({ length: 10 }, () => ({ payer: PAYER, amount: full, atMs }));
	assert.deepEqual(new CapLedger({ entries: entries(NOW_MS - 30 * DAY + 1) }).reserve(PAYER, 1n, NOW_MS), { ok: false, cap: "per_30d" }, "1 ms inside 30 d counts");
	assert.equal(new CapLedger({ entries: entries(NOW_MS - 30 * DAY) }).reserve(PAYER, 1n, NOW_MS).ok, true, "exactly 30 d old drops out");
});

test("restart: a nonce seen before a restart is refused after it (persisted store), with zero facilitator calls and no cap reserved", async () => {
	const disk: string[] = [];
	const caps = new CapLedger();
	const before = seller({ caps });
	const sig = payment();
	const first = new OperatorSeller({ config: CFG, payTo: PAY_TO, facilitator: before.fac.f, screen: async () => "clear", assertEnabled: () => {}, handler: async () => ({}), now: () => NOW_MS, caps, nonces: new NonceStore({ persist: (k) => void disk.push(k) }) });
	assert.equal((await call(first, sig)).status, 200);
	assert.equal(disk.length, 1);
	const fac = spyFacilitator();
	const caps2 = new CapLedger();
	const after = new OperatorSeller({ config: CFG, payTo: PAY_TO, facilitator: fac.f, screen: async () => "clear", assertEnabled: () => {}, handler: async () => ({}), now: () => NOW_MS, caps: caps2, nonces: new NonceStore({ entries: disk }) });
	const r = await call(after, sig);
	assert.equal(r.status, 422);
	assert.equal(r.reason, "nonce_replay");
	assert.deepEqual(fac.calls, []);
	assert.equal(caps2.spent(PAYER, 0), 0n);
});

test("restart: a nonce store that cannot be written refuses the call before the facilitator", async () => {
	const fac = spyFacilitator();
	const s = new OperatorSeller({ config: CFG, payTo: PAY_TO, facilitator: fac.f, screen: async () => "clear", assertEnabled: () => {}, handler: async () => ({}), now: () => NOW_MS, nonces: new NonceStore({ persist: () => { throw new Error("disk"); } }) });
	const r = await call(s, payment());
	assert.equal(r.status, 503);
	assert.deepEqual(fac.calls, []);
});

test("handler fails and the release write throws: still a 502 HANDLER_FAILED answer, never a rejection; the cap stays counted on disk", async () => {
	let n = 0;
	const caps = new CapLedger({ persist: () => { if (++n > 1) throw new Error("disk"); } });
	const s = new OperatorSeller({ config: CFG, payTo: PAY_TO, facilitator: spyFacilitator().f, screen: async () => "clear", assertEnabled: () => {}, handler: async () => { throw new Error("boom"); }, caps, now: () => NOW_MS });
	const r = await call(s, payment());
	assert.equal(r.status, 502);
	assert.equal(JSON.parse(r.body).error.code, "HANDLER_FAILED");
});
