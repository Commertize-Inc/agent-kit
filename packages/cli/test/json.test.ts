// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// `--json` on every command: one JSON object per result on stdout, nothing else on stdout,
// a `next_step` field on every result, the exit code carried in the object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, JSON_SCHEMA } from "../src/cli.ts";
import { ROUTES } from "../src/routes.ts";

const ADDR = "0x" + "c".repeat(40);

async function run(argv: string[], env: Record<string, string | undefined> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const saved: Record<string, string | undefined> = {};
	for (const k of ["COMMERTIZE_API_BASE_URL", "COMMERTIZE_SESSION_TOKEN", "COMMERTIZE_API_KEY"]) {
		saved[k] = process.env[k];
		if (env[k] === undefined) delete process.env[k];
		else process.env[k] = env[k];
	}
	try {
		const code = await main(argv, (l) => out.push(l), (l) => err.push(l));
		return { code, out, err };
	} finally {
		for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

function one(out: string[]) {
	assert.equal(out.length, 1, `exactly one stdout line, got ${out.length}: ${out.join(" | ")}`);
	const o = JSON.parse(out[0]!);
	assert.equal(o.schema, JSON_SCHEMA);
	assert.ok("next_step" in o, "next_step present");
	assert.ok(o.next_step === null || typeof o.next_step === "string");
	assert.equal(typeof o.ok, "boolean");
	assert.equal(typeof o.exit_code, "number");
	return o;
}

test("json: routes returns every route as data, exit 0", async () => {
	const r = await run(["routes", "--json"]);
	assert.equal(r.code, 0);
	const o = one(r.out);
	assert.equal(o.command, "routes");
	assert.equal(o.ok, true);
	assert.equal(o.exit_code, 0);
	assert.equal(o.data.routes.length, Object.keys(ROUTES).length);
	assert.ok(o.data.checked_at);
	assert.deepEqual(r.err, []);
});

test("json: the flag is accepted before the command too", async () => {
	const r = await run(["--json", "routes"]);
	assert.equal(r.code, 0);
	assert.equal(one(r.out).command, "routes");
});

test("json: usage error is a JSON object with exit 2 and a next_step", async () => {
	for (const argv of [["deploy", "--json"], ["init", "--json"], ["register", "--json"], ["mcp", "--json"]]) {
		const r = await run(argv);
		assert.equal(r.code, 2, argv.join(" "));
		const o = one(r.out);
		assert.equal(o.ok, false);
		assert.equal(o.exit_code, 2);
		assert.equal(o.error.code, "usage");
		assert.match(o.next_step, /commertize-agent help --json/);
	}
});

test("json: help with no command is exit 0 and lists commands", async () => {
	const r = await run(["help", "--json"]);
	assert.equal(r.code, 0);
	const o = one(r.out);
	assert.ok(Array.isArray(o.data.commands) && o.data.commands.includes("routes"));
	const r2 = await run(["--json"]);
	assert.equal(r2.code, 0);
	one(r2.out);
});

test("json: version", async () => {
	const o = one((await run(["version", "--json"])).out);
	assert.match(o.data.version, /^\d+\.\d+\.\d+$/);
});

test("json: init writes the template and names the next step", async () => {
	const dest = join(mkdtempSync(join(tmpdir(), "kit-json-")), "w");
	const r = await run(["init", "desk-watcher", dest, "--json"]);
	assert.equal(r.code, 0);
	const o = one(r.out);
	assert.ok(o.data.files.includes("model.ts"));
	assert.match(o.next_step, /model\.ts/);
});

test("json: mcp puts config and tools in data and writes nothing to stderr", async () => {
	const r = await run(["mcp", "desk-watcher", "--server", "/abs/mcp-server/dist/index.js", "--json"]);
	assert.equal(r.code, 0);
	const o = one(r.out);
	assert.equal(o.data.config.mcpServers.commertize.command, "node");
	assert.ok(o.data.tools.length > 0);
	assert.deepEqual(r.err, []);
});

test("json: a config error is a JSON error object, exit 1, credentials never echoed", async () => {
	const r = await run(["register", "--agent-address", ADDR, "--json"], {
		COMMERTIZE_API_BASE_URL: "https://api.commertize.co",
		COMMERTIZE_SESSION_TOKEN: "secret-session-value",
	});
	assert.equal(r.code, 1);
	const o = one(r.out);
	assert.equal(o.ok, false);
	assert.equal(o.error.code, "config");
	assert.match(o.error.message, /not api\.commertize\.com/);
	assert.doesNotMatch(r.out.join("") + r.err.join(""), /secret-session-value/);
});

test("json: register without a session token fails closed with a sign-in next_step", async () => {
	const r = await run(["register", "--agent-address", ADDR, "--json"]);
	assert.equal(r.code, 1);
	const o = one(r.out);
	assert.equal(o.error.code, "config");
	assert.match(o.next_step, /COMMERTIZE_SESSION_TOKEN|auth start/);
});

test("json: an unknown flag is a usage error, not a crash or a silent pass", async () => {
	const r = await run(["routes", "--jsn"]);
	assert.equal(r.code, 2);
	const r2 = await run(["routes", "--json", "--bogus"]);
	assert.equal(r2.code, 2);
	assert.equal(one(r2.out).error.code, "usage");
});

test("text mode is unchanged: routes prints a header plus one line per route", async () => {
	const r = await run(["routes"]);
	assert.equal(r.out.length, Object.keys(ROUTES).length + 1);
	assert.throws(() => JSON.parse(r.out[0]!));
});
