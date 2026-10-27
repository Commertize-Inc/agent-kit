// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// Copies templates/ into packages/cli/templates for the published package.
// Refuses to replace an existing destination: run from a clean checkout.
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../templates", import.meta.url));
const dest = fileURLToPath(new URL("../packages/cli/templates", import.meta.url));
if (existsSync(dest)) {
	console.error(`bundle-templates: ${dest} already exists; refusing to overwrite`);
	process.exit(1);
}
cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
console.log(`bundle-templates: copied templates to ${dest}`);
