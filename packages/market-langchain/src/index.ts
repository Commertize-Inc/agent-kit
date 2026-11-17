// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
//
// DRAFT, NOT FOR RELEASE. Read-only tool definitions over @commertize/market
// for agent frameworks whose tool factory takes (func, { name, description,
// schema }). Pass the framework's own factory in; this file imports none.
// No pay tool: paying stays an explicit call to @commertize/market/pay.

import type { MarketClient, SearchOptions } from "@commertize/market";

export interface ToolFields {
	name: string;
	description: string;
	schema: Record<string, unknown>;
}

export type ToolFactory<T> = (func: (input: Record<string, unknown>) => Promise<string>, fields: ToolFields) => T;

const idSchema = (name: string) => ({
	type: "object",
	properties: { [name]: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" } },
	required: [name],
	additionalProperties: false,
});

// Tool descriptions are draft wording pending review.
export const TOOL_TEXT = {
	search_services: "DRAFT. Search Commertize marketplace entries for services that charge per request over x402. Read-only. Defaults to Base mainnet.",
	get_service: "DRAFT. Read one Commertize marketplace service entry by service_id. Read-only.",
	get_endpoint: "DRAFT. Read one endpoint entry (price, network, payee, schemas) by endpoint_id. Read-only.",
	get_receipt: "DRAFT. Read one Commertize receipt by receipt_id. Read-only.",
} as const;

function str(v: unknown, name: string): string {
	if (typeof v !== "string") throw new Error(`${name} must be a string`);
	return v;
}

export function createMarketTools<T>(opts: { tool: ToolFactory<T>; client: MarketClient }): T[] {
	const { tool, client } = opts;
	if (typeof tool !== "function") throw new Error("pass the framework's tool factory");
	if (!client || typeof client.search !== "function") throw new Error("pass a client from createMarketClient()");
	return [
		tool(
			async (input) => {
				const o: SearchOptions = {};
				if (input.q !== undefined) o.q = str(input.q, "q");
				if (input.network !== undefined) o.network = str(input.network, "network") as SearchOptions["network"];
				if (input.max_price_usd !== undefined) o.maxPriceUsd = str(input.max_price_usd, "max_price_usd");
				if (input.checks_passed === true) o.checksPassed = true;
				if (input.entry_state !== undefined) o.entryState = str(input.entry_state, "entry_state") as SearchOptions["entryState"];
				if (input.has_receipts === true) o.hasReceipts = true;
				if (typeof input.limit === "number") o.limit = input.limit;
				return JSON.stringify(await client.search(o));
			},
			{
				name: "search_services",
				description: TOOL_TEXT.search_services,
				schema: {
					type: "object",
					properties: {
						q: { type: "string" },
						network: { type: "string", enum: ["base", "base-sepolia"], default: "base" },
						max_price_usd: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,18})?$" },
						checks_passed: { type: "boolean" },
						entry_state: { type: "string", enum: ["claimed", "unclaimed", "any"] },
						has_receipts: { type: "boolean" },
						limit: { type: "integer", minimum: 1, maximum: 50 },
					},
					additionalProperties: false,
				},
			}
		),
		tool(async (input) => JSON.stringify(await client.getService(str(input.service_id, "service_id"))), {
			name: "get_service",
			description: TOOL_TEXT.get_service,
			schema: idSchema("service_id"),
		}),
		tool(async (input) => JSON.stringify(await client.getEndpoint(str(input.endpoint_id, "endpoint_id"))), {
			name: "get_endpoint",
			description: TOOL_TEXT.get_endpoint,
			schema: idSchema("endpoint_id"),
		}),
		tool(async (input) => JSON.stringify(await client.getReceipt(str(input.receipt_id, "receipt_id"))), {
			name: "get_receipt",
			description: TOOL_TEXT.get_receipt,
			schema: idSchema("receipt_id"),
		}),
	];
}
