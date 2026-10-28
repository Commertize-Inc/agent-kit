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
 * The keychain is hygiene, not a boundary: any process running as you can
 * ask for the item (macOS may prompt).
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";
import { KitConfigError } from "./client.ts";

export const KEYCHAIN_SERVICE = "commertize-agent-kit";
export const SECURITY_BIN = "/usr/bin/security";
/** Credentials (environment or keychain). */
export const KEY_NAMES = ["COMMERTIZE_SESSION_TOKEN", "COMMERTIZE_API_KEY"] as const;
/** Every keychain item this kit may touch: the credentials plus the device signer key (signer.ts). */
export const KEYCHAIN_NAMES = [...KEY_NAMES, "COMMERTIZE_SIGNER_KEY"] as const;
export type KeyName = (typeof KEYCHAIN_NAMES)[number];
const VALUE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{7,4095}$/;

export type Runner = (args: string[], input?: string) => { status: number | null; stdout: string };

export interface Keychain {
	available(): boolean;
	has(name: KeyName): boolean;
	get(name: KeyName): string | undefined;
	set(name: KeyName, value: string): void;
	clear(name: KeyName): boolean;
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
			return run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]).status === 0;
		},
		get(name) {
			checkName(name);
			if (!ok()) return undefined;
			const r = run(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
			if (r.status !== 0) return undefined;
			const v = r.stdout.trim();
			// A stored value that fails the allowlist is refused, not used.
			if (!VALUE.test(v)) throw new KitConfigError(`keychain item ${KEYCHAIN_SERVICE}/${name} has a disallowed shape; refusing (value not shown)`);
			return v;
		},
		set(name, value) {
			checkName(name);
			checkValue(value);
			need();
			// -U updates an existing item. The value is on stdin, inside a single -i command line.
			const r = run(["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w ${value}\n`);
			if (r.status !== 0) throw new KitConfigError(`keychain write for ${name} failed (exit ${r.status})`);
		},
		clear(name) {
			checkName(name);
			need();
			return run(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]).status === 0;
		},
	};
}
