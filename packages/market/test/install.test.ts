// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// The one-command installer, run as a real process (its own entry point,
// reached through a .bin-style symlink the way npx reaches it). Every refusal
// asserts exit 2 AND that nothing was written; each has a passing control.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ORIGIN, MARKET_API_PATH } from "../src/index.ts";

const BIN_SRC = fileURLToPath(new URL("../bin/install.mjs", import.meta.url));
const SKILL = "---\nname: test-skill\n---\nfixture body\n";
const NAME = "commertize-agentic-markets";
const URL_DEFAULT = DEFAULT_ORIGIN + MARKET_API_PATH + "/mcp";

test("installer and client share one origin and API path", async () => {
	const bin = await import("../bin/install.mjs");
	assert.equal(bin.MARKET_API_PATH, MARKET_API_PATH);
	assert.equal(bin.DEFAULT_ORIGIN, DEFAULT_ORIGIN);
	assert.equal(bin.DEFAULT_MCP_URL, URL_DEFAULT);
});

test("the API path literal appears only at its two definitions in the package", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const hits: string[] = [];
	const walk = (d: string) => {
		for (const f of readdirSync(d, { withFileTypes: true })) {
			if (f.name === "node_modules" || f.name === "dist") continue;
			const p = join(d, f.name);
			if (f.isDirectory()) walk(p);
			else if (/\.(ts|mjs|js|json|md)$/.test(f.name))
				readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (l.includes(MARKET_API_PATH)) hits.push(`${p.slice(root.length)}:${i + 1}`); });
		}
	};
	walk(root);
	// skill/SKILL.md is the phrased skill r2 (hash-pinned in skill.test.ts); its three
	// literal URLs are part of those bytes, so a path change also means a skill r3.
	assert.deepEqual(hits.map((h) => h.replace(/:\d+$/, "")).sort(), [
		"bin/install.mjs",
		"skill/SKILL.md",
		"skill/SKILL.md",
		"skill/SKILL.md",
		"src/index.ts",
	]);
});

/** A throwaway package layout: <pkg>/bin/install.mjs (+ optional skill), reached via <pkg>/.bin/commertize-market. */
function pkg(withSkill = true) {
	const base = mkdtempSync(join(tmpdir(), "mkt-install-"));
	const p = join(base, "pkg");
	mkdirSync(join(p, "bin"), { recursive: true });
	copyFileSync(BIN_SRC, join(p, "bin", "install.mjs"));
	if (withSkill) {
		mkdirSync(join(p, "skill"));
		writeFileSync(join(p, "skill", "SKILL.md"), SKILL);
	}
	mkdirSync(join(p, ".bin"));
	symlinkSync(join(p, "bin", "install.mjs"), join(p, ".bin", "commertize-market"));
	const proj = join(base, "proj");
	mkdirSync(proj);
	return { bin: join(p, ".bin", "commertize-market"), proj };
}

function run(bin: string, args: string[]) {
	const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
	return { code: r.status, out: r.stdout, err: r.stderr };
}

const snapshot = (dir: string): string[] =>
	readdirSync(dir, { recursive: true }).map(String).sort();

test("control: one command writes the MCP entry and the skill file", () => {
	const { bin, proj } = pkg();
	const r = run(bin, ["install", "--dir", proj]);
	assert.equal(r.code, 0, r.err);
	const cfg = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
	assert.deepEqual(cfg, { mcpServers: { [NAME]: { type: "http", url: URL_DEFAULT } } });
	assert.equal(readFileSync(join(proj, "skills/commertize-market/SKILL.md"), "utf8"), SKILL);
	// idempotent: second run is a no-op
	const again = run(bin, ["install", "--dir", proj]);
	assert.equal(again.code, 0, again.err);
	assert.match(again.out, /unchanged: .*\.mcp\.json/);
	assert.match(again.out, /unchanged: .*SKILL\.md/);
});

test("existing servers in .mcp.json are kept", () => {
	const { bin, proj } = pkg();
	writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { other: { url: "https://x.example/mcp" } }, extra: 1 }));
	assert.equal(run(bin, ["install", "--dir", proj]).code, 0);
	const cfg = JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8"));
	assert.deepEqual(cfg.mcpServers.other, { url: "https://x.example/mcp" });
	assert.equal(cfg.extra, 1);
	assert.equal(cfg.mcpServers[NAME].url, URL_DEFAULT);
});

const refusals: Array<[string, (proj: string) => void, string[], boolean?]> = [
	["malformed .mcp.json", (p) => writeFileSync(join(p, ".mcp.json"), "{nope"), []],
	["non-object .mcp.json", (p) => writeFileSync(join(p, ".mcp.json"), "[]"), []],
	["non-object mcpServers", (p) => writeFileSync(join(p, ".mcp.json"), '{"mcpServers":[]}'), []],
	["a different existing entry", (p) => writeFileSync(join(p, ".mcp.json"), JSON.stringify({ mcpServers: { [NAME]: { type: "http", url: "https://evil.example/mcp" } } })), []],
	["a differing skill file", (p) => {
		mkdirSync(join(p, "skills/commertize-market"), { recursive: true });
		writeFileSync(join(p, "skills/commertize-market/SKILL.md"), "edited by the user\n");
	}, []],
	["a symlinked skills directory", (p) => {
		const elsewhere = mkdtempSync(join(tmpdir(), "mkt-elsewhere-"));
		symlinkSync(elsewhere, join(p, "skills"));
	}, []],
	["a symlinked .mcp.json", (p) => {
		const elsewhere = join(mkdtempSync(join(tmpdir(), "mkt-elsewhere-")), "x.json");
		writeFileSync(elsewhere, "{}");
		symlinkSync(elsewhere, join(p, ".mcp.json"));
	}, []],
	["plain http URL", () => {}, ["--url", "http://commertize.example/mcp"]],
	["URL with a query", () => {}, ["--url", "https://commertize.example/mcp?k=1"]],
	["URL with credentials", () => {}, ["--url", "https://u:p@commertize.example/mcp"]],
	["unknown option", () => {}, ["--force"]],
	["--url without a value", () => {}, ["--url"]],
	["no bundled skill file", () => {}, [], false],
];

for (const [name, setup, extra, withSkill] of refusals) {
	test(`refuses, writing nothing: ${name}`, () => {
		const { bin, proj } = pkg(withSkill ?? true);
		setup(proj);
		const before = snapshot(proj);
		const beforeMcp = existsSync(join(proj, ".mcp.json")) ? readFileSync(join(proj, ".mcp.json"), "utf8") : null;
		const r = run(bin, ["install", "--dir", proj, ...extra]);
		assert.equal(r.code, 2, `exit ${r.code}; stderr ${r.err}`);
		assert.match(r.err, /Nothing was written/);
		assert.deepEqual(snapshot(proj), before);
		const afterMcp = existsSync(join(proj, ".mcp.json")) ? readFileSync(join(proj, ".mcp.json"), "utf8") : null;
		assert.equal(afterMcp, beforeMcp);
	});
}

test("control for the missing-skill refusal: --mcp-only writes only the MCP entry", () => {
	const { bin, proj } = pkg(false);
	const r = run(bin, ["install", "--dir", proj, "--mcp-only"]);
	assert.equal(r.code, 0, r.err);
	assert.ok(existsSync(join(proj, ".mcp.json")));
	assert.equal(existsSync(join(proj, "skills")), false);
});

test("control for the URL refusals: localhost http and a custom https URL are accepted", () => {
	for (const u of ["http://localhost" + MARKET_API_PATH + "/mcp", "https://preview.commertize.example" + MARKET_API_PATH + "/mcp"]) {
		const { bin, proj } = pkg();
		assert.equal(run(bin, ["install", "--dir", proj, "--url", u]).code, 0);
		assert.equal(JSON.parse(readFileSync(join(proj, ".mcp.json"), "utf8")).mcpServers[NAME].url, u);
	}
});

test("--dry-run writes nothing and says what it would write", () => {
	const { bin, proj } = pkg();
	const r = run(bin, ["install", "--dir", proj, "--dry-run"]);
	assert.equal(r.code, 0, r.err);
	assert.match(r.out, /would write: .*\.mcp\.json/);
	assert.deepEqual(snapshot(proj), []);
});

test("not a command: no args exits 2 with usage", () => {
	const { bin } = pkg();
	const r = run(bin, []);
	assert.equal(r.code, 2);
	assert.match(r.err, /usage: commertize-market install/);
});

test("an option missing its value is refused by name, not read as the next flag", () => {
	for (const args of [["--url"], ["--dir", "--dry-run"], ["--url", "--mcp-only"]]) {
		const { bin, proj } = pkg();
		const r = run(bin, ["install", "--dir", proj, ...args]);
		assert.equal(r.code, 2);
		assert.match(r.err, /needs a value\. Nothing was written/);
		assert.deepEqual(snapshot(proj), []);
	}
});

test("the installer reads no environment and makes no network call", () => {
	const src = readFileSync(BIN_SRC, "utf8");
	assert.doesNotMatch(src, /process\.env|fetch\(|node:https?|node:net|import\.meta\.env/);
});
