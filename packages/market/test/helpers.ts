// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// In-process fake fetch. Tests make no network calls: every request is
// answered here, and a request to a host not in the table fails the test.
// Fixtures default to Base Sepolia, the client's default network.
import { MARKET_API_PATH } from "../src/index.ts";

export interface Call {
	url: string;
	init: RequestInit | undefined;
}

export type Route = (url: URL, init: RequestInit | undefined, n: number) => Response;

export function fakeFetch(routes: Record<string, Route>) {
	const calls: Call[] = [];
	const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url: input, init });
		const u = new URL(input);
		const key = `${u.origin}${u.pathname}`;
		const r = routes[key];
		if (!r) throw new Error(`test fetch: no route for ${key}`);
		return r(u, init, calls.length);
	};
	return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const BASE = "https://market.example.test" + MARKET_API_PATH;
export const PAY_TO = "0x" + "a".repeat(40);
export const USDC_BASE = "0x" + "c".repeat(40);
export const USDC_SEPOLIA = "0x" + "d".repeat(40);
export const SELLER = "https://seller.example.test/data";

export function endpointEntry(over: Record<string, unknown> = {}) {
	return {
		endpoint_id: "ep_1",
		service_id: "svc_1",
		method: "GET",
		url: SELLER,
		price: { amount: "0.01", amount_atomic: "10000", asset_symbol: "USDC", asset_address: USDC_SEPOLIA, decimals: 6 },
		network: "base-sepolia",
		chain_id: 84532,
		pay_to: PAY_TO,
		x402: { version: 1, scheme: "exact" },
		...over,
	} as never;
}

export function accepts(over: Record<string, unknown> = {}) {
	return {
		scheme: "exact",
		network: "base-sepolia",
		maxAmountRequired: "10000",
		resource: SELLER,
		payTo: PAY_TO,
		asset: USDC_SEPOLIA,
		maxTimeoutSeconds: 60,
		...over,
	};
}

export function service(over: Record<string, unknown> = {}) {
	return {
		service_id: "svc_1",
		name: "Example data",
		domain: "seller.example.test",
		network: "base-sepolia",
		entry_state: "claimed",
		listing_checks: { status: "passed", last_checked_at: "2026-11-17T00:00:00Z", checks_passed: ["pay_to"], checks_failed: [] },
		...over,
	};
}
