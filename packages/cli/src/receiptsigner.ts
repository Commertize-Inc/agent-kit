// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Receipt signatures with the agent key (CAS-1 section 5.1.1, suite secp256k1).
 *
 * The only way to sign with the agent key is a ReceiptLog built here: the log builds the record,
 * computes its hash itself (C-1), and only then asks for a signature over "CAS-v0.1\n" + that hash.
 * No function in the package index signs a hash, a message or typed data handed in by a caller.
 *
 *   message  "CAS-v0.1\n" + hash   (80 bytes)
 *   digest   keccak256(0x19 || "Ethereum Signed Message:\n80" || message)   (EIP-191)
 *   sig      base64url of r || s || v (65 bytes), low s, v 27 or 28, RFC 6979 nonce
 *   key_id   the agent address, lowercase
 *
 * Kill switch: if ~/.commertize/DISABLED exists (or cannot be checked), nothing is signed. It is
 * checked when the log is created and again before every signature.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { KitConfigError } from "./client.ts";
import { ReceiptLog, type Signature, type Signer } from "./cas.ts";
import { addressOf, AGENT_KEY } from "./agentkey.ts";
import { keccak256 } from "./keccak.ts";
import { signDigest } from "./secp256k1.ts";
import type { Keychain } from "./keychain.ts";

export const RECEIPT_PREFIX = "CAS-v0.1\n";
const HASH = /^sha256:[0-9a-f]{64}$/;

/** The operator's kill file is present (or its state cannot be read): nothing may be signed. */
export class DisabledError extends Error {
	constructor(path: string, detail?: string) {
		super(`signing is disabled: ${path} ${detail ?? "exists"}; the person you act for removes it to allow signing`);
		this.name = "DisabledError";
	}
}

export function killFilePath(home: string): string {
	return join(home, ".commertize", "DISABLED");
}

/** Throws DisabledError when the kill file exists, or when its presence cannot be determined (fail closed). */
export function assertNotDisabled(home: string): void {
	const p = killFilePath(home);
	try {
		lstatSync(p);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new DisabledError(p, `could not be checked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
	}
	throw new DisabledError(p);
}

/** The 32-byte digest a receipt signature covers. */
export function receiptDigest(hash: string): Uint8Array {
	if (!HASH.test(hash)) throw new Error('hash must be "sha256:" + 64 lowercase hex');
	const m = Buffer.from(RECEIPT_PREFIX + hash, "utf8");
	return keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`, "utf8"), m]));
}

/**
 * Internal: signs one receipt hash. Not exported from the package index; reachable only through the
 * ReceiptLog signer below (and the conformance tests, which import this module directly).
 */
export function signCasHash(hash: string, privHex: string): Signature {
	const address = addressOf(privHex);
	const sig = signDigest(receiptDigest(hash), BigInt(privHex), address);
	return { alg: "secp256k1", key_id: address.toLowerCase(), sig: sig.toString("base64url") };
}

/**
 * A ReceiptLog that signs with the agent key held in the OS keychain. `agentKeyId` in the receipts
 * is the agent address in lowercase, as section 5.1.1 requires.
 */
export function agentKeyReceiptLog(ids: { mandateId: string; agentId: string }, o: { keychain: Keychain | undefined; home: string; now?: () => Date }): ReceiptLog {
	assertNotDisabled(o.home);
	const kc = o.keychain;
	if (!kc || !kc.available()) throw new KitConfigError("no supported OS keychain here (macOS); no agent key to sign with");
	const priv = kc.get(AGENT_KEY);
	if (!priv) throw new KitConfigError("no agent key stored: pipe it in with wallet key import --stdin");
	const keyId = addressOf(priv).toLowerCase();
	const signer: Signer = (bytes) => {
		assertNotDisabled(o.home);
		const text = Buffer.from(bytes).toString("utf8");
		// Only the exact message a ReceiptLog builds: the prefix and a hash it computed.
		if (!text.startsWith(RECEIPT_PREFIX) || !HASH.test(text.slice(RECEIPT_PREFIX.length))) throw new Error("refusing to sign anything but a CAS receipt hash");
		return signCasHash(text.slice(RECEIPT_PREFIX.length), priv);
	};
	return new ReceiptLog({ mandateId: ids.mandateId, agentId: ids.agentId, agentKeyId: keyId }, signer, o.now);
}
