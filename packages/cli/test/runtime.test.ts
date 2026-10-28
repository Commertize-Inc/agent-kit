// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// Runtime tests: the real entry point (bin.ts) run as a child process, the way a coding agent runs it:
// non-interactive, stdin closed, --json, parse stdout, branch on the exit code.
// Both credential variables are always set, so the keychain is never consulted, and `configure` is not run here.
// The API base is a closed loopback port: no request leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA, COMMANDS } from "../src/cli.ts";
import { EVENT_SCHEMA } from "../src/events.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(PKG, "src", "bin.ts");

function agentRun(args: string[]) {
	const home = mkdtempSync(join(tmpdir(), "kit-rt-home-"));
	const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--conditions=source", BIN, ...args], {
		cwd: home,
		env: {
			PATH: "/usr/bin:/bin",
			HOME: home,
			COMMERTIZE_API_BASE_URL: "http://" + "127.0.0.1" + ":" + "9",
			COMMERTIZE_SESSION_TOKEN: "rt_session_0123456789",
			COMMERTIZE_API_KEY: "rt_apikey_0123456789",
		},
		input: "",
		encoding: "utf8",
		timeout: 30_000,
	});
	return { code: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
}

const last = (lines: string[]) => JSON.parse(lines.at(-1)!);

test("runtime: every one-shot command answers exactly one JSON line with schema and next_step", () => {
	for (const args of [["version"], ["help"], ["routes"], ["skill", "print"], ["nope"], ["auth", "start"], ["register"]]) {
		const r = agentRun([...args, "--json"]);
		assert.equal(r.lines.length, 1, `${args.join(" ")}: ${r.stdout}`);
		const o = last(r.lines);
		assert.equal(o.schema, JSON_SCHEMA);
		assert.ok("next_step" in o);
		assert.equal(o.exit_code, r.code, args.join(" "));
	}
});

test("runtime: exit codes an agent branches on (0 ok, 2 usage, 4 route not open)", () => {
	assert.equal(agentRun(["routes", "--json"]).code, 0);
	assert.equal(agentRun(["nope", "--json"]).code, 2);
	assert.equal(agentRun(["routes", "--bogus", "--json"]).code, 2);
	const s = agentRun(["auth", "start", "--json"]);
	assert.equal(s.code, 4);
	assert.equal(last(s.lines).error.code, "route_missing");
});

test("runtime: skill print from the entry point is the shipped SKILL.md", () => {
	const r = agentRun(["skill", "print"]);
	assert.equal(r.code, 0);
	assert.equal(r.stdout, readFileSync(join(PKG, "SKILL.md"), "utf8"));
});

test("runtime: events listen --once is NDJSON then one envelope; a dead API is a stream.error, not a crash", () => {
	const r = agentRun(["events", "listen", "--once", "--json"]);
	assert.equal(r.code, 0, r.stderr);
	const objs = r.lines.map((l) => JSON.parse(l));
	assert.deepEqual(
		objs.slice(0, -1).map((o) => o.type),
		["stream.started", "stream.error", "stream.stopped"]
	);
	assert.ok(objs.slice(0, -1).every((o) => o.schema === EVENT_SCHEMA));
	assert.equal(objs.at(-1).schema, JSON_SCHEMA);
});

test("runtime: credentials never reach stdout or stderr, on any command", () => {
	for (const args of [["register", "--agent-address", "0x" + "a".repeat(40)], ["events", "listen", "--once"], ["auth", "start"], ["help"]]) {
		for (const j of [[], ["--json"]]) {
			const r = agentRun([...args, ...j]);
			assert.doesNotMatch(r.stdout + r.stderr, /rt_session_0123456789|rt_apikey_0123456789/, args.join(" "));
		}
	}
});

test("runtime: help --json lists every command the CLI dispatches", () => {
	assert.deepEqual(last(agentRun(["help", "--json"]).lines).data.commands, [...COMMANDS]);
});
