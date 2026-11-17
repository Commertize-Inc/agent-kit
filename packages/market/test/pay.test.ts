// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// Each refusal is exercised through payEndpoint() itself and must happen
// before the step it protects (no request, or no signature), with a
// passing control beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PayRefusedError, createSpendingLimit, payEndpoint, type PaymentRequirements } from "../src/pay.ts";
import { PAY_TO, SELLER, USDC_BASE, USDC_SEPOLIA, accepts, endpointEntry, fakeFetch, json } from "./helpers.ts";

const WALLET = { address: "0x" + "e".repeat(40), signTypedData: async () => "0xsig" };

function seller(acceptsList: unknown[], paidHeaders: Record<string, string> = {}) {
	return fakeFetch({
		[SELLER]: (_u, init) => {
			const h = (init?.headers ?? {}) as Record<string, string>;
			if (h["x-payment"]) return json({ ok: true }, 200, paidHeaders);
			return json({ x402Version: 1, error: "payment required", accepts: acceptsList }, 402);
		},
	});
}

function signer() {
	const signed: PaymentRequirements[] = [];
	const createPaymentHeader = async (_w: object, v: number, req: PaymentRequirements) => {
		assert.equal(v, 1);
		signed.push(req);
		return "signed-header";
	};
	return { signed, createPaymentHeader };
}

const limit = (over: Record<string, unknown> = {}) =>
	createSpendingLimit({ network: "base", asset: USDC_BASE, perCall: "10000", total: "20000", ...over } as never);

const reason = (r: string) => (e: unknown) => e instanceof PayRefusedError && e.reason === r;

test("control: matching live request is signed once with the caller's wallet and retried with X-PAYMENT", async () => {
	const ff = seller([accepts()], { "x-commertize-receipt-id": "rc_1" });
	const s = signer();
	const r = await payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader });
	assert.equal(r.paid, true);
	assert.equal(r.amountAtomic, 10000n);
	assert.equal(r.payTo, PAY_TO);
	assert.equal(r.receiptId, "rc_1");
	assert.equal(s.signed.length, 1);
	assert.equal(ff.calls.length, 2);
	assert.equal((ff.calls[1]!.init!.headers as Record<string, string>)["x-payment"], "signed-header");
	for (const c of ff.calls) assert.equal(c.init?.redirect, "manual");
});

test("a non-402 response is returned unpaid and nothing is signed", async () => {
	const ff = fakeFetch({ [SELLER]: () => json({ free: true }) });
	const s = signer();
	const r = await payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader });
	assert.equal(r.paid, false);
	assert.equal(s.signed.length, 0);
});

test("no spending limit (missing, plain object, or zero) = refusal before any request", async () => {
	const ff = seller([accepts()]);
	const s = signer();
	for (const l of [undefined, { network: "base", asset: USDC_BASE, perCall: 10000n, total: 20000n, spent: 0n }])
		await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: l as never, fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("limit_missing"));
	assert.throws(() => limit({ perCall: "0" }), reason("limit_invalid"));
	assert.throws(() => limit({ perCall: "30000" }), reason("limit_invalid"));
	assert.throws(() => limit({ perCall: 0.01 }), reason("limit_invalid"));
	assert.throws(() => limit({ total: "1.5" }), reason("limit_invalid"));
	assert.equal(ff.calls.length, 0);
	assert.equal(s.signed.length, 0);
});

test("raw keys, seed phrases and objects carrying them are refused before any request", async () => {
	const ff = seller([accepts()]);
	const s = signer();
	const key = "0x" + "1".repeat(64);
	const seed = "abandon ".repeat(11) + "about";
	const bad: unknown[] = [key, key.slice(2), seed, new Uint8Array(32), { privateKey: key }, { account: { mnemonic: seed } }, { k: seed }, { seedPhrase: "x" }, null];
	for (const w of bad)
		await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: w as never, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), PayRefusedError, String(w));
	assert.equal(ff.calls.length, 0);
	assert.equal(s.signed.length, 0);
});

test("mainnet only by default: a Base Sepolia entry is refused unless the caller asks for it", async () => {
	const ep = endpointEntry({ network: "base-sepolia", chain_id: 84532, price: { amount: "0.01", amount_atomic: "10000", asset_symbol: "USDC", asset_address: USDC_SEPOLIA, decimals: 6 } });
	const ff = seller([accepts({ network: "base-sepolia", asset: USDC_SEPOLIA })]);
	const s = signer();
	await assert.rejects(payEndpoint({ endpoint: ep, wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("network_mismatch"));
	assert.equal(ff.calls.length, 0);
	const tl = createSpendingLimit({ network: "base-sepolia", asset: USDC_SEPOLIA, perCall: "10000", total: "10000" });
	const r = await payEndpoint({ endpoint: ep, wallet: WALLET, limit: tl, network: "base-sepolia", fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader });
	assert.equal(r.paid, true);
	// A mainnet limit cannot be spent on the testnet and vice versa.
	await assert.rejects(payEndpoint({ endpoint: ep, wallet: WALLET, limit: limit(), network: "base-sepolia", fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("limit_network"));
	// A chain id that disagrees with the network name is refused.
	await assert.rejects(payEndpoint({ endpoint: endpointEntry({ chain_id: 84532 }), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("network_mismatch"));
});

test("live request differing from the entry on payee, asset, network, amount, resource or scheme = no signature", async () => {
	const variants = [
		accepts({ payTo: "0x" + "b".repeat(40) }),
		accepts({ asset: "0x" + "f".repeat(40) }),
		accepts({ network: "base-sepolia" }),
		accepts({ maxAmountRequired: "10001" }),
		accepts({ maxAmountRequired: "9999" }),
		accepts({ resource: "https://other.example.test/data" }),
		accepts({ scheme: "upto" }),
	];
	for (const v of variants) {
		const ff = seller([v]);
		const s = signer();
		await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("live_mismatch"), JSON.stringify(v));
		assert.equal(s.signed.length, 0);
		assert.equal(ff.calls.length, 1);
	}
});

test("the payee comes from the live request: an entry payee absent from the 402 is never paid", async () => {
	const ff = seller([accepts({ payTo: "0x" + "b".repeat(40) }), accepts({ asset: "0x" + "f".repeat(40) })]);
	const s = signer();
	await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("live_mismatch"));
	assert.equal(s.signed.length, 0);
	// With a matching option among others, only the matching one is signed.
	const ff2 = seller([accepts({ payTo: "0x" + "b".repeat(40) }), accepts()]);
	await payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: limit(), fetch: ff2.fetch, createPaymentHeader: s.createPaymentHeader });
	assert.equal(s.signed[0]!.payTo, PAY_TO);
});

test("unsupported x402 version or unreadable 402 = no signature", async () => {
	for (const body of [{ x402Version: 2, accepts: [accepts()] }, { x402Version: 1, accepts: [] }, { x402Version: 1 }]) {
		const ff = fakeFetch({ [SELLER]: () => json(body, 402) });
		const s = signer();
		await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), PayRefusedError);
		assert.equal(s.signed.length, 0);
	}
});

test("per-call and total limits are enforced before signing, in integer units", async () => {
	const s = signer();
	const small = createSpendingLimit({ network: "base", asset: USDC_BASE, perCall: "9999", total: "100000" });
	await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: small, fetch: seller([accepts()]).fetch, createPaymentHeader: s.createPaymentHeader }), reason("over_per_call"));
	assert.equal(s.signed.length, 0);
	const l = limit({ total: "15000" });
	await payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: l, fetch: seller([accepts()]).fetch, createPaymentHeader: s.createPaymentHeader });
	assert.equal(l.spent, 10000n);
	await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: l, fetch: seller([accepts()]).fetch, createPaymentHeader: s.createPaymentHeader }), reason("over_total"));
	assert.equal(s.signed.length, 1);
	// A limit counted in another asset is refused before any request.
	const other = createSpendingLimit({ network: "base", asset: "0x" + "9".repeat(40), perCall: "10000", total: "10000" });
	const ff = seller([accepts()]);
	await assert.rejects(payEndpoint({ endpoint: endpointEntry(), wallet: WALLET, limit: other, fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("limit_asset"));
	assert.equal(ff.calls.length, 0);
});

test("non-https or incomplete entries are refused before any request", async () => {
	const ff = seller([accepts()]);
	const s = signer();
	await assert.rejects(payEndpoint({ endpoint: endpointEntry({ url: "http://seller.example.test/data" }), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("endpoint_url"));
	await assert.rejects(payEndpoint({ endpoint: endpointEntry({ pay_to: undefined }), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("entry_incomplete"));
	await assert.rejects(payEndpoint({ endpoint: endpointEntry({ price: { amount_atomic: "0.01", asset_address: USDC_BASE } }), wallet: WALLET, limit: limit(), fetch: ff.fetch, createPaymentHeader: s.createPaymentHeader }), reason("entry_incomplete"));
	assert.equal(ff.calls.length, 0);
});
