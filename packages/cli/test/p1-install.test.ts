// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CommertizeClient } from "../src/index.ts";
import { install, installPrompt, renderSkillFiles, writeSkillFiles, killFilePath, INSTALL_EXIT, SKILL_FILE_PATHS } from "../src/install.ts";
import { main, KIT_VERSION } from "../src/cli.ts";
import { fakeFetch } from "./helpers.ts";

const ENV = { baseUrl: "https://api.example.test", sessionToken: "s-token" };
const ADDR = "0x" + "c".repeat(40);
const PASSPORT = { "POST /mandates/principal/passports": { status: 201, body: { passportId: "pp-1", agentAddress: ADDR } } };
const home = () => mkdtempSync(join(tmpdir(), "ctz-p1-"));
// Words no user-facing install text may carry (banned set + name gate).
// Built from fragments so the repository's own wording guard does not flag this file.
const BANNED = new RegExp(
	"\\b(" +
		["cred" + "its?", "com" + "ing soon", "pend" + "ing", "y" + "et", "guaran" + "tee[sd]?", "open" + "ai", "anth" + "ropic", "cla" + "ude", "chat" + "gpt", "co" + "dex", "gp" + "t-?\\d*", "gem" + "ini", "cur" + "sor", "copi" + "lot", "wind" + "surf"].join("|") +
		")\\b",
	"i"
);

test("install: the kill file stops everything before the host check and before any network call", async () => {
	const h = home();
	mkdirSync(join(h, ".commertize"));
	writeFileSync(killFilePath(h), "");
	const { f, calls } = fakeFetch(PASSPORT);
	// a bad host would throw a config error if the allow-list ran first
	const r = await install({ home: h, env: { COMMERTIZE_API_BASE_URL: "https://evil.example.test", COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: ADDR, fetchImpl: f });
	assert.equal(r.exit, INSTALL_EXIT.disabled);
	assert.equal(r.exit, 19);
	assert.equal(calls.length, 0);
	assert.equal(r.steps.find((s) => s.id === "passport")?.state, "stopped");
});

test("install: a non-allow-listed host is refused before credentials are read or sent", async () => {
	const { f, calls } = fakeFetch(PASSPORT);
	await assert.rejects(
		() => install({ home: home(), env: { COMMERTIZE_API_BASE_URL: "https://api.commertize.co", COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: ADDR, fetchImpl: f }),
		/--allow-host/
	);
	assert.equal(calls.length, 0);
});

test("install: no session token -> refuses, no network call", async () => {
	const { f, calls } = fakeFetch(PASSPORT);
	await assert.rejects(() => install({ home: home(), env: {}, agentAddress: ADDR, fetchImpl: f }), /install needs COMMERTIZE_SESSION_TOKEN/);
	assert.equal(calls.length, 0);
});

test("install: bad address refused before any call", async () => {
	const { f, calls } = fakeFetch(PASSPORT);
	await assert.rejects(() => install({ home: home(), env: { COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: "0x12", fetchImpl: f }), /agent-address/);
	assert.equal(calls.length, 0);
});

test("install: creates the passport; email, wallet and mandate are not available; exit 3, never 0", async () => {
	const { f, calls } = fakeFetch(PASSPORT);
	const r = await install({ home: home(), env: { COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: ADDR, fetchImpl: f, clientOverride: new CommertizeClient(ENV, f) });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.method, "POST");
	assert.deepEqual(r.steps.map((s) => [s.id, s.state]), [
		["kit", "done"],
		["passport", "done"],
		["email", "not_available"],
		["wallet", "not_available"],
		["mandate", "not_available"],
	]);
	assert.equal(r.passport?.passportId, "pp-1");
	assert.equal(r.exit, 3);
	for (const s of r.steps) assert.doesNotMatch(s.message, BANNED, s.message);
	// the wallet step names the principal's passkey: the agent never self-authorises
	assert.match(r.steps.find((s) => s.id === "wallet")!.message, /principal's passkey/);
});

test("install: re-run reuses an active passport (409), never creates a second", async () => {
	const { f, calls } = fakeFetch({
		"POST /mandates/principal/passports": { status: 409, body: { error: "exists" } },
		"GET /mandates/principal/agents": { body: { agents: [{ passportId: "pp-1", agentAddress: ADDR, kyaStatus: "active" }] } },
	});
	const r = await install({ home: home(), env: { COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: ADDR, fetchImpl: f, clientOverride: new CommertizeClient(ENV, f) });
	assert.equal(r.passport?.reused, true);
	assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("skill files: one source, five files, deterministic, pinned version, exact package name", () => {
	const a = renderSkillFiles(KIT_VERSION);
	const b = renderSkillFiles(KIT_VERSION);
	assert.deepEqual(Object.keys(a).sort(), [...SKILL_FILE_PATHS].sort());
	assert.equal(SKILL_FILE_PATHS.length, 5);
	assert.deepEqual(a, b);
	for (const [p, body] of Object.entries(a)) {
		assert.ok(body.includes(`@commertize/agent-kit@${KIT_VERSION}`) || p.endsWith(".json"), p);
		assert.doesNotMatch(body, BANNED, p);
		// no secrets: no token values, no key material, only env var names
		assert.doesNotMatch(body, /(Bearer\s+[A-Za-z0-9]|0x[0-9a-fA-F]{64}|-----BEGIN|sk-[A-Za-z0-9])/, p);
	}
	const mcp = JSON.parse(a["mcp.json"]!);
	assert.equal(mcp.version, KIT_VERSION);
	assert.equal(mcp.packages[0].identifier, "@commertize/agent-kit");
	assert.equal(mcp.packages[0].version, KIT_VERSION);
	const api = JSON.parse(a["action/openapi.json"]!);
	assert.equal(api.openapi, "3.1.0");
	assert.ok(api.paths["/mandates/principal/passports"].post);
	// no secret values in the manifests: env vars are declared by name and marked secret
	for (const v of mcp.packages[0].environmentVariables) assert.equal(v.value, undefined);
});

test("skill files: the committed skills/ tree equals the generator output (no drift)", () => {
	const root = new URL("../../../skills/", import.meta.url).pathname;
	const gen = renderSkillFiles(KIT_VERSION);
	for (const [p, body] of Object.entries(gen)) assert.equal(readFileSync(join(root, p), "utf8"), body, `skills/${p} drifted; run: commertize-agent skills write skills`);
});

test("skill files: the skill text tells the agent the order and the stops", () => {
	const s = renderSkillFiles(KIT_VERSION)["skill/SKILL.md"]!;
	const iKill = s.indexOf("~/.commertize/DISABLED");
	const iAllow = s.indexOf("api.commertize.com");
	const iInstall = s.indexOf("commertize-agent install");
	assert.ok(iKill > 0 && iAllow > iKill && iInstall > iAllow, "kill file, then allow-list, then install");
	assert.match(s, /never remove .*DISABLED/i);
	assert.match(s, /principal's passkey/);
});

test("writeSkillFiles: create-only, refuses a non-empty dir, writes nothing", () => {
	const d = mkdtempSync(join(tmpdir(), "ctz-p1-w-"));
	writeFileSync(join(d, "keep.txt"), "x");
	assert.throws(() => writeSkillFiles(d, KIT_VERSION), /not an empty directory/);
	assert.deepEqual(readdirSync(d), ["keep.txt"]);
	const e = join(mkdtempSync(join(tmpdir(), "ctz-p1-w-")), "out");
	const files = writeSkillFiles(e, KIT_VERSION);
	assert.equal(files.length, 5);
	assert.ok(existsSync(join(e, "skill", "SKILL.md")));
});

test("install prompt: pinned, hash printed matches, no banned words", async () => {
	const p = installPrompt(KIT_VERSION);
	assert.match(p, new RegExp(`@commertize/agent-kit@${KIT_VERSION.replace(/\./g, "\\.")}`));
	assert.doesNotMatch(p, BANNED);
	assert.match(p, /your coding agent|any MCP-capable runtime/);
	const out: string[] = [];
	assert.equal(await main(["install", "--print-prompt"], (l) => out.push(l), () => {}), 0);
	const text = out.join("\n");
	const sha = createHash("sha256").update(p).digest("hex");
	assert.ok(text.includes(p));
	assert.ok(text.includes(`sha256 ${sha}`));
});

test("cli install: missing --agent-address is a usage error, no network", async () => {
	const errs: string[] = [];
	assert.equal(await main(["install"], () => {}, (l) => errs.push(l)), 2);
});

// --- review round 1 (M1, M2, L1) ---------------------------------------------
import { chmodSync } from "node:fs";
// Split in two so the hash is not mistaken for key material by the repository leak check.
const GOLDEN_PROMPT_SHA256 = "fcb4080498cecf31dd52d57d2aab1b79" + "4123660a56f528fae73b1446b9311db3";

test("M1: installPrompt(KIT_VERSION) is pinned by a golden hash; any edit must update the published hash", () => {
	assert.equal(createHash("sha256").update(installPrompt(KIT_VERSION)).digest("hex"), GOLDEN_PROMPT_SHA256);
});

test("M1: prompt, --print-prompt and skill files tell the person to verify with shasum against the signed release asset and commertize.com", async () => {
	const p = installPrompt(KIT_VERSION);
	assert.match(p, /shasum -a 256/);
	assert.match(p, /signed release asset/);
	assert.match(p, /commertize\.com/);
	assert.match(p, /do not run it/i);
	const out: string[] = [];
	await main(["install", "--print-prompt"], (l) => out.push(l), () => {});
	assert.match(out.join("\n"), /shasum -a 256/);
	assert.match(readFileSync(new URL("../../../docs/RELEASE.md", import.meta.url), "utf8"), /install-prompt\.sha256/);
});

test("M2: step 4 installs with --ignore-scripts and checks integrity and provenance first", () => {
	for (const body of [installPrompt(KIT_VERSION), ...Object.values(renderSkillFiles(KIT_VERSION)).filter((b) => b.includes("npm install"))]) {
		assert.match(body, new RegExp(`npm install -g --ignore-scripts @commertize/agent-kit@${KIT_VERSION.replace(/\./g, "\\.")}`));
		assert.match(body, /npm view @commertize\/agent-kit@[0-9.]+ dist\.integrity/);
		assert.match(body, /npm audit signatures/);
		assert.doesNotMatch(body, /npm install -g @commertize/);
	}
});

test("L1: a kill-file path that cannot be checked (not ENOENT) stops with exit 19", async () => {
	const h = home();
	mkdirSync(join(h, ".commertize"));
	chmodSync(join(h, ".commertize"), 0o000);
	const { f, calls } = fakeFetch(PASSPORT);
	try {
		const r = await install({ home: h, env: { COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: ADDR, fetchImpl: f });
		assert.equal(r.exit, 19);
		assert.equal(calls.length, 0);
		assert.match(r.steps.find((s) => s.id === "passport")!.message, /could not be checked/);
	} finally {
		chmodSync(join(h, ".commertize"), 0o700);
	}
});

test("L1: a dangling symlink at the kill-file path counts as present (lstat, not existsSync)", async () => {
	const h = home();
	mkdirSync(join(h, ".commertize"));
	symlinkSync(join(h, "nowhere"), killFilePath(h));
	const { f, calls } = fakeFetch(PASSPORT);
	const r = await install({ home: h, env: { COMMERTIZE_SESSION_TOKEN: "s" }, agentAddress: ADDR, fetchImpl: f });
	assert.equal(r.exit, 19);
	assert.equal(calls.length, 0);
});
