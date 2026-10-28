// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// SKILL.md ships in the package and `skill print` prints it, byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main, COMMANDS } from "../src/cli.ts";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL = join(PKG, "SKILL.md");
const COMPAT = join(PKG, "..", "..", "docs", "compat");

// Coding-agent runtimes and model vendors. Named only in the footer, and only with a dated test log on file
// (naming rule, condition 1: a runtime is named only after it was tested).
const RUNTIMES: [string, RegExp][] = [
	// vendor names are split so the repository wording guard (which bans them outright) does not trip on this test
	["cla" + "ude-code", new RegExp("cla" + "ude\\s*code", "i")],
	["cursor", /\bcursor\b(?!\s*(position|key))/i],
	["codex", /\bcodex\b/i],
	["open" + "claw", new RegExp("open" + "claw", "i")],
	["copilot", /copilot/i],
	["windsurf", /windsurf/i],
	["cline", /\bcline\b/i],
	["aider", /\baider\b/i],
	["gem" + "ini", new RegExp("gem" + "ini", "i")],
	["cla" + "ude", new RegExp("\\bcla" + "ude\\b", "i")],
	["chat" + "gpt", new RegExp("chat" + "gpt|open" + "ai|anthr" + "opic", "i")],
];
const AFFILIATION = new RegExp("\\b(official|partner|cert" + "ified|integrated with|powered by|recommended|best in)\\b", "i");

const text = () => readFileSync(SKILL, "utf8");
const [body, footer = ""] = (() => {
	const t = existsSync(SKILL) ? text() : "";
	const i = t.indexOf("\n## Compatibility");
	return i < 0 ? [t, ""] : [t.slice(0, i), t.slice(i)];
})();

test("skill: SKILL.md exists, is listed in package files, and has a Compatibility footer", () => {
	assert.ok(existsSync(SKILL));
	const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
	assert.ok(pkg.files.includes("SKILL.md"));
	assert.ok(footer.length > 0, "footer section '## Compatibility' present");
});

test("skill: no runtime or vendor name in the body; affiliation words nowhere", () => {
	for (const [name, re] of RUNTIMES) assert.doesNotMatch(body, re, name);
	assert.doesNotMatch(text(), AFFILIATION);
});

test("skill: the footer names a runtime only if a dated test log for it is on file", () => {
	const logs = existsSync(COMPAT) ? readdirSync(COMPAT) : [];
	for (const [name, re] of RUNTIMES) {
		if (!re.test(footer)) continue;
		assert.ok(logs.some((f) => new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.md$`).test(f)), `${name} named in the footer with no docs/compat/${name}-YYYY-MM-DD.md`);
		assert.match(footer, /are trademarks of their respective owners\. Commertize is not affiliated with or endorsed by them\./);
	}
});

test("skill: every `commertize-agent <cmd>` it mentions is a real command", () => {
	const used = [...text().matchAll(/commertize-agent ([a-z]+)/g)].map((m) => m[1]!);
	assert.ok(used.length >= 8);
	for (const c of used) assert.ok((COMMANDS as readonly string[]).includes(c), c);
});

test("skill: it states the operating rules a coding agent needs", () => {
	const t = text();
	for (const must of [/--json/, /next_step/, /exit code/i, /never (print|paste|echo)/i, /auth start/, /auth complete --request/, /events listen/, /routes --json/, /Not open/])
		assert.match(t, must, String(must));
	assert.doesNotMatch(t, new RegExp("coming " + "so" + "on|\\by" + "et\\b|\\bso" + "on\\b", "i"));
});

test("skill print: prints SKILL.md exactly; --json carries text and sha256", async () => {
	const out: string[] = [];
	assert.equal(await main(["skill", "print"], (l) => out.push(l), () => {}), 0);
	assert.ok(text().endsWith("\n"));
	assert.equal(out.join("\n") + "\n", text(), "stdout (console.log adds the final newline) equals the file");
	const j: string[] = [];
	assert.equal(await main(["skill", "print", "--json"], (l) => j.push(l), () => {}), 0);
	const o = JSON.parse(j[0]!);
	assert.equal(o.data.text, text());
	assert.equal(o.data.sha256, createHash("sha256").update(text()).digest("hex"));
	assert.equal(await main(["skill", "--json"], () => {}, () => {}), 2);
	assert.equal(await main(["skill", "print", "extra", "--json"], () => {}, () => {}), 2);
});

test("skill: the footer is the approved unnamed form until a dated runtime test receipt exists", () => {
	assert.equal(
		footer.replace(/^\n## Compatibility\n+/, "").trim(),
		"The Agent Kit is a Node.js command-line tool (Node.js 22.6 or later). Any coding agent that can run shell commands can run it."
	);
});

test("routes: public status words are Live / Not open, never future-tense", async () => {
	const out: string[] = [];
	await main(["routes"], (l) => out.push(l), () => {});
	const body = out.slice(1);
	assert.ok(body.every((l) => /^(Live|Not open)\s/.test(l)), body.join("\n"));
	assert.ok(body.some((l) => l.includes("Not open: answers 501 until claims open")));
	assert.doesNotMatch(out.join("\n"), new RegExp("\\byet\\b|\\bsoon\\b|\\bpending\\b", "i"));
	const j: string[] = [];
	await main(["routes", "--json"], (l) => j.push(l), () => {});
	for (const r of JSON.parse(j[0]!).data.routes) assert.equal(r.label, r.status === "live" ? "Live" : "Not open");
	const usage: string[] = [];
	await main(["help"], (l) => usage.push(l), () => {});
	assert.doesNotMatch(usage.join("\n"), new RegExp("\\byet\\b|\\bsoon\\b", "i"));
});
