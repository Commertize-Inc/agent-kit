// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-1 item 4: skill check (drift between an installed guide and this release's guide).
// K-1 item 5: `serve` renamed to `events serve`; `serve` is a reserved slot that refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommertizeClient } from "../src/index.ts";
import { skillCheck } from "../src/skillcheck.ts";
import { COMMANDS, KIT_VERSION, main } from "../src/cli.ts";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GUIDE = readFileSync(join(PKG, "SKILL.md"));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

async function json(argv: string[], deps: Parameters<typeof main>[3] = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main([...argv, "--json"], (l) => out.push(l), (l) => err.push(l), { signals: false, ...deps });
	return { code, o: JSON.parse(out.at(-1)!), err };
}

test("skill check: an exact copy is current (exit 0); one changed byte is drift (exit 15)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-skill-"));
	const same = join(dir, "same.md");
	const changed = join(dir, "changed.md");
	writeFileSync(same, GUIDE);
	writeFileSync(changed, Buffer.concat([GUIDE, Buffer.from(" ")]));
	const ok = await json(["skill", "check", "--path", same]);
	assert.equal(ok.code, 0);
	assert.equal(ok.o.data.upToDate, true);
	assert.equal(ok.o.data.skillHash, sha(GUIDE));
	assert.equal(ok.o.data.version, KIT_VERSION);
	assert.equal(ok.o.hand_back, null);
	const bad = await json(["skill", "check", "--path", same, "--path", changed]);
	assert.equal(bad.code, 15);
	assert.equal(bad.o.data.upToDate, false);
	assert.deepEqual(bad.o.data.files.map((f: { upToDate: boolean }) => f.upToDate), [true, false]);
	assert.equal(bad.o.hand_back.reason, "skill_drift");
	assert.match(bad.o.next_step, /skill print/);
});

test("skill check fails closed: missing, a directory, or an oversized file is drift; no --path is a usage error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "kit-skill2-"));
	const big = join(dir, "big.md");
	writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x61));
	const r = skillCheck(GUIDE, [join(dir, "nope.md"), dir, big]);
	assert.equal(r.upToDate, false);
	assert.deepEqual(r.files.map((f) => [f.upToDate, f.sha256]), [[false, null], [false, null], [false, null]]);
	assert.equal(r.files[0]!.problem, "missing");
	assert.equal(skillCheck(GUIDE, []).upToDate, false, "no files is never 'up to date'");
	assert.equal((await json(["skill", "check"])).code, 2);
	assert.equal((await json(["skill", "print", "--path", "x"])).code, 2);
});

test("events serve: binds 127.0.0.1 at the given port (the stream that used to be `serve`)", async () => {
	const seen: { port: number; host: string }[] = [];
	const r = await json(["events", "serve", "--port", "9124", "--once"], {
		client: () => new CommertizeClient({ baseUrl: "https://api.commertize.com" }, (async () => new Response(JSON.stringify({ tasks: [] }))) as typeof fetch),
		listenServer: async (_h, port, host) => (seen.push({ port, host }), { close: async () => {} }),
	});
	assert.equal(r.code, 0);
	assert.equal(r.o.command, "events");
	assert.deepEqual(seen, [{ port: 9124, host: "127.0.0.1" }]);
});

test("serve is a reserved slot: exit 4, nothing bound, nothing sent, pointed at events serve", async () => {
	for (const argv of [["serve"], ["serve", "--port", "9125"], ["serve", "status", "--anything"]]) {
		let bound = 0;
		let sent = 0;
		const r = await json(argv, {
			client: () => new CommertizeClient({ baseUrl: "https://api.commertize.com" }, (async () => (sent++, new Response("{}"))) as typeof fetch),
			listenServer: async () => (bound++, { close: async () => {} }),
		});
		assert.equal(r.code, 4, argv.join(" "));
		assert.equal(r.o.error.code, "not_open");
		assert.equal(r.o.hand_back.reason, "serve_not_open");
		assert.equal(r.o.next_step, "commertize-agent events serve --json");
		assert.equal(bound + sent, 0);
	}
	assert.ok((COMMANDS as readonly string[]).includes("serve"), "the name stays reserved");
});

test("the paid-endpoint spec stub exists, says what is built today, and is listed in help", async () => {
	const stub = readFileSync(join(ROOT, "docs", "serve-paid-endpoint.md"), "utf8");
	assert.match(stub, /^# /m);
	assert.match(stub, /Status: specified\. Not open\./);
	assert.match(stub, /events serve/);
	const help: string[] = [];
	await main(["help"], (l) => help.push(l), () => {});
	assert.match(help.join("\n"), /events serve \[--port 8787\]/);
	assert.match(help.join("\n"), /reserved/);
	for (const c of ["whoami", "agents", "mandate"]) assert.ok((COMMANDS as readonly string[]).includes(c), c);
});

test("skill check: a FIFO --path is drift (exit 15) at once, never opened", async () => {
	const { spawnSync } = await import("node:child_process");
	const fifo = join(mkdtempSync(join(tmpdir(), "kit-skill-fifo-")), "SKILL.md");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	const r = await json(["skill", "check", "--path", fifo]);
	assert.equal(r.code, 15);
	assert.equal(r.o.data.files[0].problem, "not a regular file");
});
