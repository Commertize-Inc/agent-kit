// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// Supply-chain shape of the package: no install scripts, no runtime
// dependencies, exact peer pin, no environment reads or telemetry hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("..", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

test("no install lifecycle scripts; prepack is build-only", () => {
	for (const s of ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare", "prepublish"])
		assert.equal(pkg.scripts?.[s], undefined, s);
	assert.equal(pkg.scripts?.prepack, "npm run build");
});

test("no runtime dependencies; x402 is an optional exact-pinned peer", () => {
	assert.equal(pkg.dependencies, undefined);
	assert.equal(pkg.optionalDependencies, undefined);
	assert.deepEqual(pkg.peerDependencies, { x402: "0.7.3" });
	assert.deepEqual(pkg.peerDependenciesMeta, { x402: { optional: true } });
});

test("draft stays unpublishable until the release PR", () => {
	assert.equal(pkg.private, true);
	assert.equal(pkg.name, "@commertize/market");
});

test("User-Agent version equals the package version", async () => {
	const { VERSION } = await import("../src/index.ts");
	assert.equal(VERSION, pkg.version);
});

test("sources read no environment and import nothing outside the package", () => {
	const dir = new URL("src/", root);
	for (const f of readdirSync(dir)) {
		const src = readFileSync(new URL(f, dir), "utf8");
		assert.doesNotMatch(src, /process\.env|import\.meta\.env|navigator\.sendBeacon/, f);
		for (const m of src.matchAll(/from\s+"([^"]+)"/g)) assert.match(m[1]!, /^\.\//, `${f} imports ${m[1]}`);
	}
});
