// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// release.yml shape (runbook OWNER_npm_publish_agent_kit_2026-10-28 R1): tag-only, OIDC trusted publishing,
// version == tag, tests before publish, no long-lived token, pinned actions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const y = () => readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
const strip = (s: string) => s.replace(/#.*$/gm, "");

test("release: triggers only on a v* tag push (no branch, PR, dispatch or schedule)", () => {
	const t = strip(y());
	assert.match(t, /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- "v\*\.\*\.\*"/);
	for (const bad of [/pull_request/, /workflow_dispatch/, /schedule:/, /branches:/, /workflow_run/]) assert.doesNotMatch(t, bad);
});

test("release: least privilege; id-token only on the publish job; environment npm", () => {
	const t = strip(y());
	assert.match(t, /^permissions:\s*\n\s+contents: read\s*$/m);
	assert.equal((t.match(/id-token: write/g) ?? []).length, 1);
	assert.match(t, /environment:\s*npm/);
	assert.doesNotMatch(t, /contents: write|packages: write|actions: write/);
});

test("release: no stored token anywhere; provenance on; public access; packages/cli only", () => {
	const t = strip(y());
	assert.doesNotMatch(t, /secrets\./);
	assert.doesNotMatch(t, /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
	assert.match(t, /npm publish --provenance --access public/);
	assert.match(t, /working-directory: packages\/cli/);
});

test("release: version must equal the tag, and tests + wording guard run before publish", () => {
	const t = strip(y());
	const i = (re: RegExp) => t.search(re);
	assert.ok(i(/GITHUB_REF_NAME/) > 0, "tag read from GITHUB_REF_NAME");
	assert.match(t, /exit 1/);
	assert.ok(i(/npm test/) > 0 && i(/npm test/) < i(/npm publish/));
	assert.ok(i(/check-wording/) > 0 && i(/check-wording/) < i(/npm publish/));
	assert.ok(i(/npm ci --ignore-scripts/) > 0);
	assert.ok(i(/GITHUB_REF_NAME/) < i(/npm publish/));
});

test("release: every action is pinned by a full commit SHA; checkout keeps no credentials", () => {
	const t = strip(y());
	const uses = [...t.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
	assert.ok(uses.length >= 2);
	for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
	assert.match(t, /persist-credentials: false/);
	assert.doesNotMatch(t, /\$\{\{\s*github\.event\.(head_commit|pull_request|issue|comment)/, "no untrusted event text in run steps");
});
