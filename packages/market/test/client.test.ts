// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BASE_URL, MarketApiError, MarketConfigError, createMarketClient, receiptMatches } from "../src/index.ts";
import { BASE, PAY_TO, fakeFetch, json, service } from "./helpers.ts";

test("default base URL is the production path; http refused except localhost; no query or credentials", () => {
	const noop = async () => json({});
	assert.equal(createMarketClient({ fetch: noop }).baseUrl, DEFAULT_BASE_URL);
	assert.equal(DEFAULT_BASE_URL, "https://commertize.com/api/market/v1");
	const loop = ["http:", "", "localhost"].join("/") + "/api/market/v1";
	assert.equal(createMarketClient({ fetch: noop, baseUrl: loop + "/" }).baseUrl, loop);
	for (const b of ["http://market.example.test/api", "https://u:p@market.example.test", "https://market.example.test/?x=1", "not a url"])
		assert.throws(() => createMarketClient({ fetch: noop, baseUrl: b }), MarketConfigError, b);
});

test("search defaults to Base mainnet and sends the v2.1 param names", async () => {
	const ff = fakeFetch({ [`${BASE}/services`]: () => json({ results: [service()], next_cursor: null }) });
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	const r = await c.search({ q: "weather", checksPassed: true, maxPriceUsd: "0.05", entryState: "claimed", hasReceipts: true, limit: 5 });
	const u = new URL(ff.calls[0]!.url);
	assert.equal(u.searchParams.get("network"), "base");
	assert.equal(u.searchParams.get("checks_passed"), "true");
	assert.equal(u.searchParams.get("max_price_usd"), "0.05");
	assert.equal(u.searchParams.get("entry_state"), "claimed");
	assert.equal(u.searchParams.get("has_receipts"), "true");
	assert.equal(u.searchParams.get("verified"), null);
	assert.equal(r.network, "base");
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0]!.testnet, undefined);
	assert.equal(ff.calls[0]!.init?.method, "GET");
	assert.equal(ff.calls[0]!.init?.redirect, "error");
});

test("search drops rows from another network; Base Sepolia only when asked and marked testnet", async () => {
	const mixed = [service(), service({ service_id: "svc_2", network: "base-sepolia" })];
	const ff = fakeFetch({ [`${BASE}/services`]: () => json({ results: mixed, next_cursor: "c2" }) });
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	const main = await c.search();
	assert.deepEqual(main.results.map((s) => s.service_id), ["svc_1"]);
	assert.equal(main.dropped_other_network, 1);
	const t = await c.search({ network: "base-sepolia" });
	assert.equal(new URL(ff.calls[1]!.url).searchParams.get("network"), "base-sepolia");
	assert.deepEqual(t.results.map((s) => [s.service_id, s.testnet]), [["svc_2", true]]);
	await assert.rejects(c.search({ network: "any" as never }), MarketConfigError);
	await assert.rejects(c.search({ network: "ethereum" as never }), MarketConfigError);
	assert.equal(ff.calls.length, 2);
});

test("search refuses bad params before any request", async () => {
	const ff = fakeFetch({});
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	await assert.rejects(c.search({ maxPriceUsd: -1 }), MarketConfigError);
	await assert.rejects(c.search({ maxPriceUsd: "1e3" }), MarketConfigError);
	await assert.rejects(c.search({ limit: 51 }), MarketConfigError);
	await assert.rejects(c.search({ limit: 0 }), MarketConfigError);
	await assert.rejects(c.search({ entryState: "x" as never }), MarketConfigError);
	await assert.rejects(c.search({ sort: "receipted_calls_30d_desc" as never }), MarketConfigError);
	assert.equal(ff.calls.length, 0);
});

test("get_service / get_endpoint / get_receipt: ids are validated and the echoed id must match", async () => {
	const ff = fakeFetch({
		[`${BASE}/services/svc_1`]: () => json(service()),
		[`${BASE}/services/svc_x`]: () => json(service()),
		[`${BASE}/endpoints/ep_9`]: () => json({ endpoint_id: "ep_9", network: "base-sepolia" }),
	});
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	assert.equal((await c.getService("svc_1")).service_id, "svc_1");
	await assert.rejects(c.getService("svc_x"), MarketApiError);
	assert.equal((await c.getEndpoint("ep_9")).testnet, true);
	for (const bad of ["../receipts/r", "a/b", "", "x".repeat(129)]) await assert.rejects(c.getService(bad), MarketConfigError);
	assert.equal(ff.calls.length, 3);
});

test("API errors surface the one error shape", async () => {
	const ff = fakeFetch({ [`${BASE}/services/svc_1`]: () => json({ error: { code: "not_found", message: "No such service.", param: "service_id" } }, 404) });
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	await assert.rejects(c.getService("svc_1"), (e: unknown) => e instanceof MarketApiError && e.status === 404 && e.code === "not_found" && e.param === "service_id");
});

test("receipt matches(): amount, payee and endpoint must all equal; integers only", async () => {
	const rec = { receipt_id: "rc_1", endpoint_id: "ep_1", pay_to: PAY_TO, amount_atomic: "10000", network: "base" };
	const ff = fakeFetch({ [`${BASE}/receipts/rc_1`]: () => json(rec) });
	const r = await createMarketClient({ baseUrl: BASE, fetch: ff.fetch }).getReceipt("rc_1");
	assert.equal(r.matches({ amount: "10000", payee: PAY_TO.toUpperCase().replace("0X", "0x"), endpoint: "ep_1" }), true);
	assert.equal(r.matches({ amount: 10000n, payee: PAY_TO, endpoint: "ep_1" }), true);
	assert.equal(r.matches({ amount: "10001", payee: PAY_TO, endpoint: "ep_1" }), false);
	assert.equal(r.matches({ amount: "10000", payee: "0x" + "b".repeat(40), endpoint: "ep_1" }), false);
	assert.equal(r.matches({ amount: "10000", payee: PAY_TO, endpoint: "ep_2" }), false);
	assert.equal(r.matches({ amount: "0.01" as never, payee: PAY_TO, endpoint: "ep_1" }), false);
	assert.equal(receiptMatches({ ...rec, amount_atomic: "1e4" }, { amount: "10000", payee: PAY_TO, endpoint: "ep_1" }), false);
});
