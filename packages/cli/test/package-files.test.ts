// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));

test("package: every non-build entry in `files` exists, so the tarball is not missing it", () => {
	// dist and templates are produced by prepack; everything else must be in the repository.
	for (const f of pkg.files as string[]) {
		if (f === "dist" || f === "templates") continue;
		assert.ok(existsSync(join(PKG_DIR, f)), `${f} is listed in files but missing`);
	}
});

test("package: LICENSE is Apache-2.0 and NOTICE names Commertize, Inc.", () => {
	assert.match(readFileSync(join(PKG_DIR, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
	assert.match(readFileSync(join(PKG_DIR, "NOTICE"), "utf8"), /Commertize, Inc\./);
	assert.match(readFileSync(join(PKG_DIR, "README.md"), "utf8"), /github\.com\/Commertize-Inc\/agent-kit/);
});
