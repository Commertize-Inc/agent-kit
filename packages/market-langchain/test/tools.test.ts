// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMarketClient } from "../../market/src/index.ts";
import { createMarketTools, type ToolFields } from "../src/index.ts";

const BASE = "https://market.example.test/api/market/v1";

test("four read-only tools, no pay tool; search defaults to Base mainnet", async () => {
	const urls: string[] = [];
	const fetch = async (u: string) => {
		urls.push(u);
		return new Response(JSON.stringify({ results: [], next_cursor: null }), { status: 200 });
	};
	const made: { fields: ToolFields; func: (i: Record<string, unknown>) => Promise<string> }[] = [];
	const tools = createMarketTools({ tool: (func, fields) => (made.push({ func, fields }), fields.name), client: createMarketClient({ baseUrl: BASE, fetch }) });
	assert.deepEqual(tools, ["search_services", "get_service", "get_endpoint", "get_receipt"]);
	for (const m of made) assert.match(m.fields.description, /^DRAFT\. .*Read-only/);
	await made[0]!.func({ q: "weather" });
	assert.equal(new URL(urls[0]!).searchParams.get("network"), "base");
	await assert.rejects(made[1]!.func({ service_id: 7 }));
	assert.equal(urls.length, 1);
});
