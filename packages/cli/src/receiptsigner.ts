// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Receipt signatures with the agent key (CAS-1 section 5.1.1, suite secp256k1), and the kill switch
 * for ALL kit signing (ed25519 included).
 *
 * The kit's own way to sign with the agent key is a ReceiptLog built here: the log builds the record,
 * computes its hash itself (C-1), and only then asks for a signature over "CAS-v0.1\n" + that hash.
 * No function exported from the package index signs a hash, a message or typed data handed in by a
 * caller. This is a property of the kit's API, not a security boundary: any code running as the same
 * user can read the raw key from the keychain (keychain.ts) and sign whatever it likes.
 *
 *   message  "CAS-v0.1\n" + hash   (80 bytes)
 *   digest   keccak256(0x19 || "Ethereum Signed Message:\n80" || message)   (EIP-191)
 *   sig      base64url of r || s || v (65 bytes), low s, v 27 or 28, RFC 6979 nonce
 *   key_id   the agent address, lowercase
 *
 * Kill switch ~/.commertize/DISABLED: while it exists, or its state cannot be read, the kit signs
 * nothing (either suite) and sends no write (non-GET) call. Signing is OFF by default: the first time
 * the kit sets up ~/.commertize it creates the file, and only `receipt enable-signing --confirm`,
 * run by the person, removes it. The kill file is a cooperative stop for this kit; the real stop for
 * an agent is the server side (a credential or account freeze, or revoking the mandate).
 */

import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KitConfigError } from "./client.ts";
import { ReceiptLog, type Signature, type Signer } from "./cas.ts";
import { addressOf, AGENT_KEY } from "./agentkey.ts";
import { keccak256 } from "./keccak.ts";
import { signDigest } from "./secp256k1.ts";
import type { Keychain } from "./keychain.ts";

export const RECEIPT_PREFIX = "CAS-v0.1\n";
const HASH = /^sha256:[0-9a-f]{64}$/;

/** The kill file is present (or its state cannot be read): nothing may be signed or written. */
export class DisabledError extends Error {
	constructor(path: string, detail?: string) {
		super(
			`signing is disabled: ${path} ${detail ?? "exists"}. Signing is off until the person you act for enables it on this machine ` +
				"(they run: commertize-agent receipt enable-signing --confirm). An agent never enables it itself."
		);
		this.name = "DisabledError";
	}
}

export const kitDirOf = (home: string): string => join(home, ".commertize");
export function killFilePath(home: string): string {
	return join(kitDirOf(home), "DISABLED");
}
/** Written by enable-signing: the person turned signing on at least once on this machine. */
export function enabledMarkerPath(home: string): string {
	return join(kitDirOf(home), "signing-enabled.json");
}

/** Three-state: absent (ENOENT) -> false; present -> true; any other error -> throws (callers treat as disabled). */
function exists(p: string): boolean {
	try {
		lstatSync(p);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}

/**
 * Default off: if the person has never enabled signing here, make sure the kill file exists.
 * Returns true when it created the file. Fails closed: any unreadable state counts as disabled.
 */
export function ensureDefaultDisabled(home: string): boolean {
	try {
		if (exists(killFilePath(home)) || exists(enabledMarkerPath(home))) return false;
		mkdirSync(kitDirOf(home), { recursive: true, mode: 0o700 });
		writeFileSync(killFilePath(home), "signing is off until the person runs: commertize-agent receipt enable-signing --confirm\n", { mode: 0o600, flag: "wx" });
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw new DisabledError(killFilePath(home), `could not be set up (${(e as NodeJS.ErrnoException).code ?? "error"})`);
	}
}

/** Throws DisabledError when signing is not explicitly on: kill file present, never enabled, or state unreadable. */
export function assertNotDisabled(home: string): void {
	const p = killFilePath(home);
	try {
		if (exists(p)) throw new DisabledError(p);
		if (!exists(enabledMarkerPath(home))) throw new DisabledError(p, "is absent but signing was never enabled on this machine");
	} catch (e) {
		if (e instanceof DisabledError) throw e;
		throw new DisabledError(p, `could not be checked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
	}
}

/** The person's deliberate step: removes the kill file and records that signing was enabled. */
export function enableSigning(home: string, now: Date = new Date()): { path: string } {
	mkdirSync(kitDirOf(home), { recursive: true, mode: 0o700 });
	writeFileSync(enabledMarkerPath(home), JSON.stringify({ v: 1, enabledAt: now.toISOString() }) + "\n", { mode: 0o600 });
	try {
		unlinkSync(killFilePath(home));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	return { path: killFilePath(home) };
}

/** Anyone may turn signing off: creates the kill file. */
export function disableSigning(home: string): { path: string; created: boolean } {
	mkdirSync(kitDirOf(home), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(killFilePath(home), "signing disabled\n", { mode: 0o600, flag: "wx" });
		return { path: killFilePath(home), created: true };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return { path: killFilePath(home), created: false };
		throw e;
	}
}

/** Wraps any signer (ed25519 included) so the kill switch is checked before every signature. */
export function guardSigner(signer: Signer, home: string): Signer {
	return (bytes) => {
		assertNotDisabled(home);
		return signer(bytes);
	};
}

/** The 32-byte digest a receipt signature covers. */
export function receiptDigest(hash: string): Uint8Array {
	if (!HASH.test(hash)) throw new Error('hash must be "sha256:" + 64 lowercase hex');
	const m = Buffer.from(RECEIPT_PREFIX + hash, "utf8");
	return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`, "utf8"), m]));
}

/** Internal (not exported from the index): signs one receipt hash. */
export function signCasHash(hash: string, privHex: string): Signature {
	const address = addressOf(privHex);
	const sig = signDigest(receiptDigest(hash), BigInt(privHex), address);
	return { alg: "secp256k1", key_id: address.toLowerCase(), sig: sig.toString("base64url") };
}

/** Internal (not exported from the index): the agent-key signer. Refuses anything but a receipt message. */
export function agentKeySigner(privHex: string, home: string): Signer {
	return guardSigner((bytes) => {
		const text = Buffer.from(bytes).toString("utf8");
		// Only the exact message a ReceiptLog builds: the prefix and a hash it computed.
		if (!text.startsWith(RECEIPT_PREFIX) || !HASH.test(text.slice(RECEIPT_PREFIX.length))) throw new Error("refusing to sign anything but a CAS receipt hash");
		return signCasHash(text.slice(RECEIPT_PREFIX.length), privHex);
	}, home);
}

/**
 * A ReceiptLog that signs with the agent key held in the OS keychain. `agentKeyId` in the receipts
 * is the agent address in lowercase, as section 5.1.1 requires.
 */
export function agentKeyReceiptLog(ids: { mandateId: string; agentId: string }, o: { keychain: Keychain | undefined; home: string; now?: () => Date }): ReceiptLog {
	ensureDefaultDisabled(o.home);
	assertNotDisabled(o.home);
	const kc = o.keychain;
	if (!kc || !kc.available()) throw new KitConfigError("no supported OS keychain here (macOS); no agent key to sign with");
	const priv = kc.get(AGENT_KEY);
	if (!priv) throw new KitConfigError("no agent key stored: pipe it in with wallet key import --stdin");
	const keyId = addressOf(priv).toLowerCase();
	return new ReceiptLog({ mandateId: ids.mandateId, agentId: ids.agentId, agentKeyId: keyId }, agentKeySigner(priv, o.home), o.now);
}
