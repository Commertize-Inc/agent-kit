// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// The bundled skill file is the phrased skill r2 block, byte for byte, and the
// real installer copies exactly those bytes. Any edit is skill r3 (new hash,
// new phrase, second opinion), so this test must go red on any change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_R2_SHA256 = "15a01fb8b58a0fb8e152f519b7a210298f37819c23c4650bd659e4141d018bf7";
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const bundled = join(pkgRoot, "skill", "SKILL.md");

test("bundled skill/SKILL.md is skill r2 (sha256 15a01fb8)", () => {
	const h = createHash("sha256").update(readFileSync(bundled)).digest("hex");
	assert.equal(h, SKILL_R2_SHA256);
});

test("package files list ships the skill directory", () => {
	const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
	assert.ok(pkg.files.includes("skill"));
});

test("the real installer writes the bundled bytes unchanged", () => {
	const base = mkdtempSync(join(tmpdir(), "ctz-market-skill-"));
	try {
		execFileSync(process.execPath, [join(pkgRoot, "bin", "install.mjs"), "install", "--dir", base], { stdio: "pipe" });
		const out = readFileSync(join(base, "skills", "commertize-market", "SKILL.md"));
		assert.equal(createHash("sha256").update(out).digest("hex"), SKILL_R2_SHA256);
	} finally {
		if (base.startsWith(join(tmpdir(), "ctz-market-skill-"))) rmSync(base, { recursive: true, force: true });
	}
});
