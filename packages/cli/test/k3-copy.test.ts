// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-3 copy pins: every reviewed string (by id) appears verbatim in the shipped source; help text is
// compared with the column padding collapsed. The two replaced strings' old wording is gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { USAGE_TEXT } from "../src/cli.ts";
import { ROUTES } from "../src/routes.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const HELP = flat(USAGE_TEXT);
const CLI = src("cli.ts");
const ATTEST = src("attest.ts");

const PINS: [string, string, string][] = [
	["apx-ff774747f2", "help", "check a mandate request or a cap increase request on this machine; sending it is Not open (exit 4) and nothing is sent; exit 19 if ~/.commertize/DISABLED"],
	["apx-cfca3a49f0", "help", "hand back to the person you act for: they create or change and sign the mandate (exit 5); the kit never writes or signs a mandate"],
	["apx-40568cd707", "attest", "the device signer attests only a mandate signature request or a cap increase request; refused: "],
	["apx-656dfa5ed7", "attest", "lowering a cap is not an increase"],
	["apx-b04e4d90d3", "attest", "toCaps increases no cap"],
	["apx-bb54ade124", "attest", "expiresAt must be a future UTC time (ISO 8601, Z)"],
	["apx-b5e1d01f40", "cli", "this typed data is not on the list the agent key may sign (the list is empty in this release)"],
	["apx-0632012553", "cli", "mandate request-change takes --mandate <mandateId> and --caps <file> with fromCaps and toCaps"],
	["apx-c44a5b8574", "cli", "--caps file is larger than 64 KiB"],
	["apx-110cdfb137", "cli", "--caps file is not JSON"],
	["apx-bb23d3c6e5", "cli", "--caps file for request-change must have exactly fromCaps and toCaps"],
	["apx-6cdba4ffd9", "cli", "--level, --expires, --agent, --mandate and --profile go with mandate request --caps or request-change --caps"],
	["apx-ffc54a3e81", "cli", "--mandate goes with mandate request-change"],
];

test("K-3 reviewed strings ship verbatim", () => {
	for (const [id, where, s] of PINS) {
		const hay = where === "help" ? HELP : where === "attest" ? ATTEST : CLI;
		assert.ok(hay.includes(s), `${id} not found verbatim in ${where}`);
	}
});

test("apx-3719d3ddf4: the request route note, still labelled Not open", () => {
	assert.equal(ROUTES.mandateRequestCreate.note, "A mandate request (or cap increase request) from your agent, attested by its device signer and waiting for you; you approve and sign it in the dashboard.");
	assert.equal(ROUTES.mandateRequestCreate.pending, "Not open");
	assert.equal(ROUTES.mandateRequestCreate.status, "missing");
});

test("the replaced wordings are gone", () => {
	assert.ok(!src("routes.ts").includes("A pending mandate request"));
	assert.ok(!CLI.includes("request-change has exactly fromCaps"));
});
