// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { cpSync, existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KitConfigError } from "./client.ts";

export const TEMPLATES = ["sponsor-scout", "register-cleaner", "data-consumer", "desk-watcher"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Bundled templates (published package) or the repository's templates/ (from source). */
export function templatesRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	for (const c of [join(here, "..", "templates"), join(here, "..", "..", "..", "templates")])
		if (existsSync(join(c, "sponsor-scout", "agent.ts"))) return c;
	throw new KitConfigError("templates not found next to the CLI");
}

/**
 * Copies one template into `target`, which must not exist or be an empty
 * directory. Never overwrites a file. Writes no credentials: your keys stay
 * in your environment.
 */
export function init(name: string, target: string, kitVersion: string): string[] {
	if (!(TEMPLATES as readonly string[]).includes(name))
		throw new KitConfigError(`unknown template "${name}". Choose one of: ${TEMPLATES.join(", ")}`);
	const dest = resolve(target);
	if (existsSync(dest)) {
		if (lstatSync(dest).isSymbolicLink() || !lstatSync(dest).isDirectory() || readdirSync(dest).length > 0)
			throw new KitConfigError(`${dest} exists and is not an empty directory; nothing written`);
	}
	cpSync(join(templatesRoot(), name), dest, { recursive: true, errorOnExist: true, force: false });
	writeFileSync(
		join(dest, "package.json"),
		JSON.stringify(
			{
				name: `my-${name}`,
				private: true,
				type: "module",
				scripts: { start: "node --experimental-strip-types main.ts" },
				dependencies: { "@commertize/agent-kit": kitVersion },
				engines: { node: ">=22.6" },
			},
			null,
			"\t"
		) + "\n",
		{ flag: "wx" }
	);
	return readdirSync(dest).sort();
}
