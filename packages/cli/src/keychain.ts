// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Credential storage in the OS keychain (macOS login keychain), the same
 * pattern Commertize uses internally:
 *
 *  - one service, `commertize-agent-kit`; accounts COMMERTIZE_SESSION_TOKEN
 *    and COMMERTIZE_API_KEY, plus the device signer key (signer.ts);
 *  - only through /usr/bin/security, by absolute path, after checking it is a
 *    root-owned regular file not writable by group or others (never a PATH
 *    lookup);
 *  - a value goes to `security -i` on STDIN, never on argv (so never in `ps`),
 *    and its charset is an allowlist, so it cannot smuggle a second command;
 *  - never printed, never logged, no file fallback. On a platform without
 *    the macOS keychain, storing refuses: use the environment variables.
 *
 * The keychain is hygiene, not a boundary. These items are created through
 * /usr/bin/security, which is on each item's access list, so any process
 * running as you can read them through the same tool silently: there is no
 * prompt.
 *
 * Lookups are three-state: found (exit 0), not found (exit 44, the CLI's
 * "item not found"), or anything else (a locked or unavailable keychain, a
 * headless session), which stops the command instead of being read as
 * "not stored".
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";
import { KitConfigError } from "./client.ts";

export const KEYCHAIN_SERVICE = "commertize-agent-kit";
export const SECURITY_BIN = "/usr/bin/security";
/** Credentials (environment or keychain). */
export const KEY_NAMES = ["COMMERTIZE_SESSION_TOKEN", "COMMERTIZE_API_KEY"] as const;
/** Every keychain item this kit may touch: the credentials, the device signer key (signer.ts) and the agent key (agentkey.ts). */
export const KEYCHAIN_NAMES = [...KEY_NAMES, "COMMERTIZE_SIGNER_KEY", "COMMERTIZE_AGENT_KEY"] as const;
export type KeyName = (typeof KEYCHAIN_NAMES)[number];
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,4095}$/;

export type Runner = (args: string[], input?: string) => { status: number | null; stdout: string };

export interface Keychain {
	available(): boolean;
	has(name: KeyName): boolean;
	get(name: KeyName): string | undefined;
	set(name: KeyName, value: string): void;
	clear(name: KeyName): boolean;
	/** Create only: never replaces an existing item ("exists"). Required for the device signer. */
	add?(name: KeyName, value: string): "added" | "exists";
}

/** The CLI's exit status for "item not found". */
export const ITEM_NOT_FOUND = 44;
/** The CLI's exit status for "item already exists" (add without -U). */
export const ITEM_EXISTS = 45;

/** Three-state lookup: 0 found, 44 not found, anything else stops the command. */
function found(status: number | null, name: string): boolean {
	if (status === 0) return true;
	if (status === ITEM_NOT_FOUND) return false;
	throw new KitConfigError(`the OS keychain did not answer for ${name} (exit ${status}; locked or unavailable?); stopping rather than reading it as absent`);
}

export function checkName(name: string): KeyName {
	if (!(KEYCHAIN_NAMES as readonly string[]).includes(name)) throw new KitConfigError(`keychain name must be one of ${KEYCHAIN_NAMES.join(", ")}`);
	return name as KeyName;
}

export function checkValue(v: string): string {
	if (typeof v !== "string" || !VALUE.test(v)) throw new KitConfigError("credential has a disallowed shape (8-4096 of A-Z a-z 0-9 . _ ~ + / = -); nothing stored (value not shown)");
	return v;
}

/** Root-owned, regular, not group/other-writable. */
export function securityBinOk(path = SECURITY_BIN, platform = process.platform): boolean {
	if (platform !== "darwin") return false;
	try {
		const st = statSync(path);
		return st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0;
	} catch {
		return false;
	}
}

const defaultRunner: Runner = (args, input) => {
	const r: SpawnSyncReturns<string> = spawnSync(SECURITY_BIN, args, {
		input: input ?? "",
		encoding: "utf8",
		timeout: 20_000,
		env: { PATH: "/usr/bin:/bin" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	return { status: r.status, stdout: r.stdout ?? "" };
};

export function osKeychain(run: Runner = defaultRunner, ok: () => boolean = () => securityBinOk()): Keychain {
	const need = () => {
		if (!ok()) throw new KitConfigError("no supported OS keychain here (macOS /usr/bin/security); use the environment variables instead");
	};
	return {
		available: ok,
		has(name) {
			checkName(name);
			if (!ok()) return false;
			return found(run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]).status, name);
		},
		get(name) {
			checkName(name);
			if (!ok()) return undefined;
			const r = run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
			if (!found(r.status, name)) return undefined;
			const v = r.stdout.trim();
			// A stored value that fails the allowlist is refused, not used.
			if (!VALUE.test(v)) throw new KitConfigError(`keychain item ${KEYCHAIN_SERVICE}/${name} has a disallowed shape; refusing (value not shown)`);
			return v;
		},
		set(name, value) {
			checkName(name);
			// set() replaces an existing item (-U): only credentials may be replaced. Key items are create-only (add()).
			if (!(KEY_NAMES as readonly string[]).includes(name)) throw new KitConfigError(`${name} is a key item: it is created once and never replaced; nothing stored`);
			checkValue(value);
			need();
			// -U updates an existing item. The value is on stdin, inside a single -i command line.
			const r = run(["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w ${value}\n`);
			if (r.status !== 0) throw new KitConfigError(`keychain write for ${name} failed (exit ${r.status})`);
		},
		add(name, value) {
			checkName(name);
			checkValue(value);
			need();
			// No -U: the keychain itself refuses to replace an existing item, atomically.
			const r = run(["-i"], `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${name} -w ${value}\n`);
			if (r.status === 0) return "added";
			if (r.status === ITEM_EXISTS) return "exists";
			// Any other status: find out whether an item is there (three-state; a locked keychain stops here).
			if (this.has(name)) return "exists";
			throw new KitConfigError(`keychain write for ${name} failed (exit ${r.status})`);
		},
		clear(name) {
			checkName(name);
			need();
			// Three-state, like lookups: 0 cleared, 44 not stored, anything else (locked keychain) stops.
			return found(run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]).status, name);
		},
	};
}
