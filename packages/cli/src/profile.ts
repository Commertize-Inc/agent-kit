// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * The active agent for a profile: which of the principal's agents later
 * commands act as (`agents --use`). Stored at
 * `~/.commertize/profiles/<name>.json` (directories 0700, file 0600):
 * `{ v, passportId, agentAddress, setAt }`. It holds no credential and no
 * key: only the public ids `agents` already prints.
 *
 * Reading fails closed: a file that is not this shape, or a directory on
 * the path that is a symlink, stops the command instead of being guessed at.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KitConfigError } from "./client.ts";

const NAME = /^[a-z0-9_-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface ActiveAgent {
	passportId: string;
	agentAddress: string;
	setAt: string;
}

export function checkProfileName(name: string): string {
	if (!NAME.test(name)) throw new KitConfigError("--profile is 1-32 characters of a-z 0-9 _ -");
	return name;
}

/** The kit's own directory under a home directory. */
export function kitDir(home: string): string {
	return join(home, ".commertize");
}

function profilePath(home: string, name: string): string {
	return join(kitDir(home), "profiles", `${checkProfileName(name)}.json`);
}

/** Each directory we own must be a real directory, never a symlink. Missing is fine (create=false: report missing). */
function ensureDir(path: string, create: boolean): boolean {
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink() || !st.isDirectory()) throw new KitConfigError(`${path} is not a plain directory; refusing`);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		if (!create) return false;
		mkdirSync(path, { mode: 0o700 });
		return true;
	}
}

export function readActiveAgent(home: string, name: string): ActiveAgent | null {
	const p = profilePath(home, name);
	if (!ensureDir(kitDir(home), false) || !ensureDir(join(kitDir(home), "profiles"), false)) return null;
	let raw: string;
	try {
		const st = lstatSync(p);
		if (!st.isFile()) throw new KitConfigError(`${p} is not a regular file; refusing`);
		raw = readFileSync(p, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(raw);
	} catch {
		throw new KitConfigError(`${p} is not a profile this kit wrote; refusing`);
	}
	if (o?.v !== 1 || typeof o.passportId !== "string" || !UUID.test(o.passportId) || typeof o.agentAddress !== "string" || !ADDRESS.test(o.agentAddress) || typeof o.setAt !== "string")
		throw new KitConfigError(`${p} is not a profile this kit wrote; refusing`);
	return { passportId: o.passportId, agentAddress: o.agentAddress, setAt: o.setAt };
}

export function writeActiveAgent(home: string, name: string, a: { passportId: string; agentAddress: string }, now: Date = new Date()): { path: string; value: ActiveAgent } {
	if (!UUID.test(a.passportId) || !ADDRESS.test(a.agentAddress)) throw new KitConfigError("refusing to store an agent id or address that is not well formed");
	const p = profilePath(home, name);
	ensureDir(kitDir(home), true);
	ensureDir(join(kitDir(home), "profiles"), true);
	const value: ActiveAgent = { passportId: a.passportId, agentAddress: a.agentAddress, setAt: now.toISOString() };
	// Exclusive create with an unpredictable name, then rename: never written through a planted symlink.
	const tmp = `${p}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
	writeFileSync(tmp, JSON.stringify({ v: 1, ...value }) + "\n", { mode: 0o600, flag: "wx" });
	renameSync(tmp, p);
	return { path: p, value };
}
