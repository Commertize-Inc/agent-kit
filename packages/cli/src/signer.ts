// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * The device signer: a P-256 key that later proves "this request comes from
 * the operator's machine" when the agent asks its principal for a mandate or
 * a change. It never signs a payment, a transfer or a mandate.
 *
 *   signer init     generate the key, keep the private half in the OS
 *                   keychain (stdin to /usr/bin/security, never argv, never
 *                   printed), print the public key and its fingerprint
 *   signer status   whether a key is stored, its fingerprint, and the link state
 *   signer link     binding the key to your agent needs the pairing routes,
 *                   which are Not open: it stops before any network call
 *
 * The private key is stored as PKCS#8 DER in base64url. Any process running
 * as you can read it silently (keychain.ts), and it is exportable: this kit
 * does not use a hardware-backed key. So, while the key is software-only, it
 * is an attestation key only: it never signs a payment, a transfer or a
 * mandate. `signer link` stays Not open until the server both offers pairing
 * and requires the principal to re-link after a key rotation.
 * `signer init` never replaces a stored key; remove one with
 * `configure --clear COMMERTIZE_SIGNER_KEY`.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { KitConfigError } from "./client.ts";
import type { Keychain } from "./keychain.ts";

export const SIGNER_KEY = "COMMERTIZE_SIGNER_KEY" as const;

export class SignerExistsError extends Error {
	constructor() {
		super("a signer key is already stored; nothing replaced");
		this.name = "SignerExistsError";
	}
}

export interface SignerInfo {
	curve: "P-256";
	/** SubjectPublicKeyInfo DER, base64url. */
	publicKey: string;
	/** "sha256:" + hex SHA-256 of the SubjectPublicKeyInfo DER. */
	fingerprint: string;
}

function infoFromPrivate(pkcs8b64u: string): SignerInfo {
	let key;
	try {
		key = createPrivateKey({ key: Buffer.from(pkcs8b64u, "base64url"), format: "der", type: "pkcs8" });
	} catch {
		throw new KitConfigError(`keychain item ${SIGNER_KEY} is not a key this kit wrote; refusing (value not shown)`);
	}
	if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
		throw new KitConfigError(`keychain item ${SIGNER_KEY} is not a P-256 key; refusing (value not shown)`);
	const spki = createPublicKey(key).export({ format: "der", type: "spki" });
	return { curve: "P-256", publicKey: spki.toString("base64url"), fingerprint: "sha256:" + createHash("sha256").update(spki).digest("hex") };
}

function needKeychain(kc: Keychain | undefined): Keychain {
	if (!kc || !kc.available()) throw new KitConfigError("no supported OS keychain here (macOS /usr/bin/security); a signer key is never kept in a file");
	return kc;
}

export function signerInit(kc: Keychain | undefined): SignerInfo {
	const k = needKeychain(kc);
	if (!k.add) throw new KitConfigError("this keychain cannot create an item without replacing one; no signer key stored");
	// has() is three-state: a locked or unreadable keychain stops here, before any write.
	if (k.has(SIGNER_KEY)) throw new SignerExistsError();
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pkcs8 = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url");
	const want = infoFromPrivate(pkcs8);
	// Create-only: if another init got there first, the keychain refuses and that key is left alone.
	if (k.add(SIGNER_KEY, pkcs8) === "exists") throw new SignerExistsError();
	// Read it back: report only a key the keychain actually holds.
	let stored: string | undefined;
	try {
		stored = k.get(SIGNER_KEY);
	} catch {
		throw new KitConfigError("the keychain could not be read back after storing the signer key; nothing removed, run signer status");
	}
	if (stored === pkcs8) return want;
	// Not what this process wrote: someone else's key (a concurrent init) or nothing. Never delete a key we did not write.
	if (stored === undefined) throw new KitConfigError("the signer key just stored is not in the keychain; nothing kept");
	throw new SignerExistsError();
}

export function signerStatus(kc: Keychain | undefined): { stored: boolean; signer: SignerInfo | null } {
	const k = needKeychain(kc);
	const v = k.get(SIGNER_KEY);
	return v ? { stored: true, signer: infoFromPrivate(v) } : { stored: false, signer: null };
}
