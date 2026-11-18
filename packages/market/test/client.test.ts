// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAIN_IDS, DEFAULT_BASE_URL, DEFAULT_NETWORK, DEFAULT_ORIGIN, MARKET_API_PATH, MarketApiError, MarketConfigError, TRANSFER_ONLY_LABEL, createMarketClient } from "../src/index.ts";
import * as market from "../src/index.ts";
import { BASE, PAY_TO, fakeFetch, json, service } from "./helpers.ts";

test("default base URL is DEFAULT_ORIGIN + MARKET_API_PATH; http refused except localhost; no query or credentials", () => {
	const noop = async () => json({});
	assert.equal(createMarketClient({ fetch: noop }).baseUrl, DEFAULT_BASE_URL);
	assert.equal(DEFAULT_BASE_URL, DEFAULT_ORIGIN + MARKET_API_PATH);
	// the API host; the site host commertize.com serves no /api route (AXIOM F-1)
	assert.equal(DEFAULT_ORIGIN, "https://api.commertize.com");
	assert.equal(DEFAULT_BASE_URL, "https://api.commertize.com" + MARKET_API_PATH);
	assert.equal(BASE, "https://market.example.test" + MARKET_API_PATH);
	const loop = ["http:", "", "localhost"].join("/") + MARKET_API_PATH;
	assert.equal(createMarketClient({ fetch: noop, baseUrl: loop + "/" }).baseUrl, loop);
	for (const b of ["http://market.example.test/api", "https://u:p@market.example.test", "https://market.example.test/?x=1", "not a url"])
		assert.throws(() => createMarketClient({ fetch: noop, baseUrl: b }), MarketConfigError, b);
});

test("search defaults to Base Sepolia (84532) and sends the v2.1 param names", async () => {
	assert.equal(DEFAULT_NETWORK, "base-sepolia");
	assert.equal(CHAIN_IDS[DEFAULT_NETWORK], 84532);
	const ff = fakeFetch({ [`${BASE}/services`]: () => json({ results: [service()], next_cursor: null }) });
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	assert.equal(c.allowMainnet, false);
	const r = await c.search({ q: "weather", category: "data", checksPassed: true, maxPriceUsd: "0.05", sort: "price_asc", limit: 5, cursor: "o10" });
	const u = new URL(ff.calls[0]!.url);
	assert.equal(u.searchParams.get("network"), "base-sepolia");
	assert.equal(u.searchParams.get("checks_passed"), "true");
	assert.equal(u.searchParams.get("max_price_usd"), "0.05");
	// only the API's accepted names, each once (the API 400s unknown or repeated ones)
	const accepted = ["q", "category", "network", "max_price_usd", "checks_passed", "sort", "limit", "cursor"];
	const names = [...u.searchParams.keys()];
	assert.deepEqual([...names].sort(), [...accepted].sort());
	assert.equal(new Set(names).size, names.length);
	assert.equal(u.searchParams.get("verified"), null);
	assert.equal(r.network, "base-sepolia");
	assert.equal(r.results.length, 1);
	assert.equal(r.results[0]!.testnet, true);
	assert.equal(ff.calls[0]!.init?.method, "GET");
	assert.equal(ff.calls[0]!.init?.redirect, "error");
});

test("search on Base mainnet is refused before any request unless the client has allowMainnet: true", async () => {
	const mixed = [service(), service({ service_id: "svc_2", network: "base" })];
	const ff = fakeFetch({ [`${BASE}/services`]: () => json({ results: mixed, next_cursor: "c2" }) });
	for (const allow of [undefined, false, "true", 1]) {
		const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch, allowMainnet: allow as never });
		await assert.rejects(c.search({ network: "base" }), MarketConfigError, String(allow));
	}
	assert.equal(ff.calls.length, 0);
	// Default search drops the mainnet row; opted-in mainnet search drops the testnet row.
	const def = await createMarketClient({ baseUrl: BASE, fetch: ff.fetch }).search();
	assert.deepEqual(def.results.map((s) => [s.service_id, s.testnet]), [["svc_1", true]]);
	assert.equal(def.dropped_other_network, 1);
	const m = await createMarketClient({ baseUrl: BASE, fetch: ff.fetch, allowMainnet: true }).search({ network: "base" });
	assert.equal(new URL(ff.calls[1]!.url).searchParams.get("network"), "base");
	assert.deepEqual(m.results.map((s) => [s.service_id, s.testnet]), [["svc_2", undefined]]);
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch, allowMainnet: true });
	await assert.rejects(c.search({ network: "any" as never }), MarketConfigError);
	await assert.rejects(c.search({ network: "ethereum" as never }), MarketConfigError);
	assert.equal(ff.calls.length, 2);
});

test("options the API does not accept are never sent (has_receipts, entry_state)", async () => {
	const ff = fakeFetch({ [`${BASE}/services`]: () => json({ results: [], next_cursor: null }) });
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	await c.search({ q: "x", hasReceipts: true, entryState: "claimed" } as never);
	const u = new URL(ff.calls[0]!.url);
	assert.equal(u.searchParams.get("has_receipts"), null);
	assert.equal(u.searchParams.get("entry_state"), null);
	assert.deepEqual([...u.searchParams.keys()].sort(), ["network", "q"]);
});

test("search refuses bad params before any request", async () => {
	const ff = fakeFetch({});
	const c = createMarketClient({ baseUrl: BASE, fetch: ff.fetch });
	await assert.rejects(c.search({ maxPriceUsd: -1 }), MarketConfigError);
	await assert.rejects(c.search({ maxPriceUsd: "1e3" }), MarketConfigError);
	await assert.rejects(c.search({ limit: 51 }), MarketConfigError);
	await assert.rejects(c.search({ limit: 0 }), MarketConfigError);
	await assert.rejects(c.search({ sort: "receipted_calls_30d_desc" as never }), MarketConfigError);
	await assert.rejects(c.search({ sort: "relevance" as never }), MarketConfigError);
	await assert.rejects(c.search({ category: ["data", "search"] as never }), MarketConfigError);
	assert.equal(ff.calls.length, 0);
});

test("get_service / get_endpoint: ids are validated and the echoed id must match", async () => {
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

test("no receipt call or receipt match is exported; the transfer-only label is AXIOM's bytes", () => {
	// /receipts/{id} is not served on the market path and would not carry
	// amount, payee or endpoint (AEGIS design D); the old match is gone.
	for (const k of ["receiptMatches", "get_receipt"]) assert.equal(k in market, false, k);
	assert.equal("getReceipt" in createMarketClient({ fetch: async () => json({}) }), false);
	assert.equal(TRANSFER_ONLY_LABEL, "transfer found on-chain, no receipt binding");
});
