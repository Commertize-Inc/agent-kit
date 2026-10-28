// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * The agent key: the secp256k1 key whose address you registered as your
 * agent (`register --agent-address`). You hold it; Commertize never
 * generates, receives, keeps, recovers or co-signs it.
 *
 *   wallet key import --stdin   read the key (0x + 64 hex) from stdin, never
 *                               argv or the environment; check it; derive its
 *                               address; store it create-only in the OS
 *                               keychain. If an active agent is set
 *                               (`agents --use`), the address must match it.
 *   wallet key status           whether a key is stored and its address
 *   wallet sign-typed-data      refuses every payload (see below)
 *
 * Signing. This release signs nothing with the agent key. The closed list of
 * typed-data domains an agent may sign is empty:
 *   - "CAS Mandate" typed data is signed by the principal, never the agent
 *     (CAS-1 §4): refused, handed back to the principal;
 *   - Permit2 and EIP-2612 permits move value: refused (payments are Not open);
 *   - anything else: refused as not on the list.
 * CAS receipts are signed over "CAS-v0.1\n" + hash, not as typed data; the
 * CAS v0.1 receipt spec publishes no secp256k1 test vectors, so the kit
 * signs receipts with ed25519 only.
 */

import { createECDH } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { KitConfigError } from "./client.ts";
import { keccak256, toChecksumAddress } from "./keccak.ts";
import type { Keychain } from "./keychain.ts";

export const AGENT_KEY = "COMMERTIZE_AGENT_KEY" as const;
/** secp256k1 group order n. A private key must be in [1, n-1]. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const KEY = /^0x[0-9a-fA-F]{64}$/;

export class AgentKeyExistsError extends Error {
	constructor() {
		super("an agent key is already stored; nothing replaced");
		this.name = "AgentKeyExistsError";
	}
}

/** Validates a private key and returns its EIP-55 address. The key is never echoed in an error. */
export function addressOf(privHex: string): string {
	if (!KEY.test(privHex)) throw new KitConfigError("the agent key must be 0x followed by 64 hex characters (value not shown)");
	const k = BigInt(privHex);
	if (k < 1n || k >= N) throw new KitConfigError("the agent key is outside the secp256k1 range (value not shown)");
	const e = createECDH("secp256k1");
	e.setPrivateKey(Buffer.from(privHex.slice(2), "hex"));
	const pub = e.getPublicKey(); // 65 bytes, 0x04 || X || Y
	return toChecksumAddress(Buffer.from(keccak256(pub.subarray(1))).subarray(12).toString("hex"));
}

function needKeychain(kc: Keychain | undefined): Keychain {
	if (!kc || !kc.available()) throw new KitConfigError("no supported OS keychain here (macOS); the agent key is never kept in a file");
	if (!kc.add) throw new KitConfigError("this keychain cannot create an item without replacing one; nothing stored");
	return kc;
}

/**
 * Stores the key create-only. `expect` is the active agent's address: a key
 * for another address is refused before anything is written.
 */
export function importAgentKey(kc: Keychain | undefined, raw: string, expect: string | null): { address: string; matched: boolean | null } {
	const k = needKeychain(kc);
	const v = raw.trim();
	const address = addressOf(v);
	if (expect !== null && expect.toLowerCase() !== address.toLowerCase())
		throw new KitConfigError(`this key's address is ${address}, not the active agent ${expect}; nothing stored`);
	if (k.has(AGENT_KEY)) throw new AgentKeyExistsError();
	if (k.add!(AGENT_KEY, v.toLowerCase()) === "exists") throw new AgentKeyExistsError();
	let stored: string | undefined;
	try {
		stored = k.get(AGENT_KEY);
	} catch {
		throw new KitConfigError("the keychain could not be read back after storing the agent key; nothing removed, run wallet key status");
	}
	if (stored === v.toLowerCase()) return { address, matched: expect === null ? null : true };
	if (stored === undefined) throw new KitConfigError("the agent key just stored is not in the keychain; nothing kept");
	throw new AgentKeyExistsError(); // another import got there first: its key is left alone
}

export function agentKeyStatus(kc: Keychain | undefined): { stored: boolean; address: string | null } {
	if (!kc || !kc.available()) throw new KitConfigError("no supported OS keychain here (macOS)");
	const v = kc.get(AGENT_KEY);
	return v ? { stored: true, address: addressOf(v) } : { stored: false, address: null };
}

// --- typed data: classify, then refuse ------------------------------------------

export type TypedDataClass = "cas_mandate" | "permit" | "other";

const PERMIT_TYPES = new Set(["Permit", "PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom", "PermitWitnessTransferFrom", "PermitBatchWitnessTransferFrom"]);

/** What a typed-data payload is, read from its domain name and primary type only (nothing is hashed or signed). */
export function classifyTypedData(td: unknown): { class: TypedDataClass; domainName: string | null; primaryType: string | null } {
	const o = (td && typeof td === "object" ? td : {}) as Record<string, unknown>;
	const domain = (o.domain && typeof o.domain === "object" ? o.domain : {}) as Record<string, unknown>;
	const domainName = typeof domain.name === "string" ? domain.name : null;
	const primaryType = typeof o.primaryType === "string" ? o.primaryType : null;
	const types = o.types && typeof o.types === "object" ? Object.keys(o.types as object) : [];
	if (domainName === "CAS Mandate" || primaryType === "Mandate") return { class: "cas_mandate", domainName, primaryType };
	if (domainName === "Permit2" || (primaryType !== null && PERMIT_TYPES.has(primaryType)) || types.some((t) => PERMIT_TYPES.has(t)))
		return { class: "permit", domainName, primaryType };
	return { class: "other", domainName, primaryType };
}

export const TYPED_DATA_MAX_BYTES = 256 * 1024;

/** Reads a typed-data JSON file: regular file only (a FIFO is refused before open), size-capped. */
export function readTypedDataFile(path: string): unknown {
	if (!statSync(path).isFile()) throw new KitConfigError(`${path} is not a regular file`);
	const fd = openSync(path, "r");
	try {
		const st = fstatSync(fd);
		if (st.size > TYPED_DATA_MAX_BYTES) throw new KitConfigError(`${path} is larger than ${TYPED_DATA_MAX_BYTES} bytes`);
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < st.size) {
			const n = readSync(fd, buf, off, st.size - off, off);
			if (n === 0) break;
			off += n;
		}
		try {
			return JSON.parse(buf.subarray(0, off).toString("utf8"));
		} catch {
			throw new KitConfigError(`${path} is not JSON`);
		}
	} finally {
		closeSync(fd);
	}
}
