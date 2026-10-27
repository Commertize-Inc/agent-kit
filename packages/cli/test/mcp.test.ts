// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KitConfigError, TEMPLATE_MCP_TOOLS, mcpClientConfig } from "../src/index.ts";
import { TEMPLATES } from "../src/init.ts";
import { main } from "../src/cli.ts";

const ENTRY = "/opt/commertize-mcp-server/dist/index.js";

test("mcp: every template has a tool list, and no tool list names an unknown template", () => {
	assert.deepEqual(Object.keys(TEMPLATE_MCP_TOOLS).sort(), [...TEMPLATES].sort());
	for (const name of TEMPLATES) assert.ok(TEMPLATE_MCP_TOOLS[name].length > 0, name);
});

test("mcp: paid and write tools are always behind a gate", () => {
	const mustGate = /^(x402_|submit_|get_submission)/;
	for (const tools of Object.values(TEMPLATE_MCP_TOOLS))
		for (const t of tools) if (mustGate.test(t.name)) assert.ok(t.gate, `${t.name} has no gate`);
});

test("mcp: the config opens no gate and carries no credential", () => {
	for (const name of TEMPLATES) {
		const { config } = mcpClientConfig(name, ENTRY);
		const server = config.mcpServers.commertize;
		assert.equal(server.command, "node");
		assert.deepEqual(server.args, [ENTRY]);
		assert.deepEqual(server.env, {});
		assert.doesNotMatch(JSON.stringify(config), /ENABLE|KEY|TOKEN|SECRET/i);
	}
});

test("mcp: a relative, non-js or blank server path is refused", () => {
	for (const bad of ["dist/index.js", "./dist/index.js", "/opt/server/dist", "", "   "])
		assert.throws(() => mcpClientConfig("desk-watcher", bad), KitConfigError, JSON.stringify(bad));
});

test("mcp: an unknown template is refused", () => {
	assert.throws(() => mcpClientConfig("hosted-builder", ENTRY), /unknown template/);
});

test("cli mcp: prints the config on stdout and the gates on stderr", async () => {
	const out: string[] = [];
	const err: string[] = [];
	assert.equal(await main(["mcp", "sponsor-scout", "--server", ENTRY], (l) => out.push(l), (l) => err.push(l)), 0);
	const parsed = JSON.parse(out.join("\n"));
	assert.deepEqual(parsed.mcpServers.commertize.args, [ENTRY]);
	const notes = err.join("\n");
	assert.match(notes, /COMMERTIZE_MCP_ENABLE_SUBMISSIONS/);
	assert.match(notes, /in review on the server/);
	assert.match(notes, /this config sets none/);
});

test("cli mcp: missing template or --server is a usage error, nothing printed on stdout", async () => {
	for (const argv of [["mcp"], ["mcp", "desk-watcher"], ["mcp", "--server", ENTRY]]) {
		const out: string[] = [];
		assert.equal(await main(argv, (l) => out.push(l), () => {}), 2, argv.join(" "));
		assert.equal(out.length, 0);
	}
});

test("cli mcp: a bad server path exits 1 with the reason", async () => {
	const err: string[] = [];
	assert.equal(await main(["mcp", "desk-watcher", "--server", "dist/index.js"], () => {}, (l) => err.push(l)), 1);
	assert.match(err.join("\n"), /absolute path/);
});
