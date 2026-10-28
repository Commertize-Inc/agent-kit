// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-1 item 5: the loopback stream is events serve; serve is a reserved slot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommertizeClient } from "../src/index.ts";
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
	for (const argv of [["serve"], ["serve", "--port", "9125"], ["serve", "start", "--anything"]]) {
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
	assert.match(stub, /Status: specified\. Not built\./);
	assert.match(stub, /events serve/);
	const help: string[] = [];
	await main(["help"], (l) => help.push(l), () => {});
	assert.match(help.join("\n"), /events serve \[--port 8787\]/);
	assert.match(help.join("\n"), /reserved/);
});
