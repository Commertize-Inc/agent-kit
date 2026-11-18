#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
//
// DRAFT, NOT FOR RELEASE. One-command install of Commertize Agentic Markets
// into an agent project:
//
//   npx @commertize/market install [--dir <path>] [--url <mcp-url>] [--mcp-only] [--dry-run]
//
// Writes, inside --dir (default: the current directory) and nowhere else:
//   .mcp.json                          adds one server entry (merged, never replaced)
//   skills/commertize-market/SKILL.md  the skill file shipped in this package
//
// Fail-closed: every check runs before any write. It refuses (exit 2, nothing
// written) on malformed JSON, an existing entry or skill file that differs, a
// symlinked target, a non-https URL, or a missing bundled skill file (unless
// --mcp-only). No network, no environment reads, no keys, no accounts.

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "commertize-agentic-markets";
// Same values as DEFAULT_ORIGIN / MARKET_API_PATH in src/index.ts (this bin
// runs on plain Node and cannot import the TypeScript source); test/install.test.ts
// pins them equal. The served path is not settled yet: change both together.
export const DEFAULT_ORIGIN = "https://commertize.com";
export const MARKET_API_PATH = "/api/market/v1";
export const DEFAULT_MCP_URL = DEFAULT_ORIGIN + MARKET_API_PATH + "/mcp";
export const SKILL_REL = join("skills", "commertize-market", "SKILL.md");
export const MCP_REL = ".mcp.json";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED_SKILL = join(PKG_ROOT, "skill", "SKILL.md");

class Refusal extends Error {}

function parseArgs(argv) {
	const [cmd, ...rest] = argv;
	if (cmd !== "install") throw new Refusal("usage: commertize-market install [--dir <path>] [--url <mcp-url>] [--mcp-only] [--dry-run]");
	const o = { dir: ".", url: DEFAULT_MCP_URL, mcpOnly: false, dryRun: false };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "--mcp-only") o.mcpOnly = true;
		else if (a === "--dry-run") o.dryRun = true;
		else if (a === "--dir" || a === "--url") {
			const v = rest[++i];
			if (v === undefined || v.startsWith("--")) throw new Refusal(`${a} needs a value`);
			o[a.slice(2)] = v;
		} else throw new Refusal(`unknown option: ${a}`);
	}
	return o;
}

export function checkUrl(raw) {
	let u;
	try {
		u = new URL(raw);
	} catch {
		throw new Refusal("--url is not a valid URL");
	}
	const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
		throw new Refusal("--url must be https (plain http only for localhost)");
	if (u.username || u.password || u.search || u.hash)
		throw new Refusal("--url must not carry credentials, a query or a fragment");
	return u.toString();
}

function refuseSymlink(p) {
	if (existsSync(p) && lstatSync(p).isSymbolicLink())
		throw new Refusal(`${p} is a symlink; not writing through it`);
}

/** Refuse if `target` (or any parent up to `root`) is a symlink or escapes root. */
function checkInside(root, target) {
	if (!(target === root || target.startsWith(root + sep)))
		throw new Refusal(`${target} is outside ${root}`);
	for (let p = target; p !== root && p.length > root.length; p = dirname(p)) refuseSymlink(p);
}

export function plan(opts) {
	const root = resolve(opts.dir);
	if (!existsSync(root) || !lstatSync(root).isDirectory())
		throw new Refusal(`--dir ${root} is not a directory`);
	const url = checkUrl(opts.url);
	const entry = { type: "http", url };
	const steps = [];

	const mcpPath = join(root, MCP_REL);
	checkInside(root, mcpPath);
	let cfg = {};
	if (existsSync(mcpPath)) {
		try {
			cfg = JSON.parse(readFileSync(mcpPath, "utf8"));
		} catch {
			throw new Refusal(`${mcpPath} is not valid JSON; fix it first`);
		}
		if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
			throw new Refusal(`${mcpPath} is not a JSON object`);
	}
	const servers = cfg.mcpServers ?? {};
	if (typeof servers !== "object" || servers === null || Array.isArray(servers))
		throw new Refusal(`${mcpPath}: mcpServers is not an object`);
	const prev = servers[SERVER_NAME];
	if (prev !== undefined) {
		if (JSON.stringify(prev) !== JSON.stringify(entry))
			throw new Refusal(`${mcpPath} already has a different "${SERVER_NAME}" entry; not changing it`);
		steps.push({ path: mcpPath, action: "unchanged" });
	} else {
		const next = { ...cfg, mcpServers: { ...servers, [SERVER_NAME]: entry } };
		steps.push({ path: mcpPath, action: "write", body: JSON.stringify(next, null, 2) + "\n" });
	}

	if (!opts.mcpOnly) {
		if (!existsSync(BUNDLED_SKILL))
			throw new Refusal("this build carries no skill file; rerun with --mcp-only to add the MCP entry alone");
		const skill = readFileSync(BUNDLED_SKILL, "utf8");
		const skillPath = join(root, SKILL_REL);
		checkInside(root, skillPath);
		if (existsSync(skillPath)) {
			if (readFileSync(skillPath, "utf8") !== skill)
				throw new Refusal(`${skillPath} exists and differs; not overwriting it`);
			steps.push({ path: skillPath, action: "unchanged" });
		} else steps.push({ path: skillPath, action: "write", body: skill });
	}
	return steps;
}

function apply(steps) {
	for (const s of steps) {
		if (s.action !== "write") continue;
		mkdirSync(dirname(s.path), { recursive: true });
		const tmp = `${s.path}.tmp-${process.pid}`;
		writeFileSync(tmp, s.body, { flag: "wx" });
		renameSync(tmp, s.path);
	}
}

export function main(argv, out = console.log, err = console.error) {
	try {
		const opts = parseArgs(argv);
		const steps = plan(opts);
		if (!opts.dryRun) apply(steps);
		for (const s of steps)
			out(`${opts.dryRun && s.action === "write" ? "would write" : s.action === "write" ? "wrote" : "unchanged"}: ${s.path}`);
		return 0;
	} catch (e) {
		if (e instanceof Refusal) {
			err(`commertize-market: ${e.message}. Nothing was written.`);
			return 2;
		}
		throw e;
	}
}

// npx runs this through a node_modules/.bin symlink: compare real paths.
const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url)))
	process.exitCode = main(process.argv.slice(2));
