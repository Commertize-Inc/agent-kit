// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * What the device signer will attest, and nothing else.
 *
 * The device signer (signer.ts) proves "this request comes from the
 * operator's machine". It attests exactly two typed-data schemas:
 *
 *   MandateSignatureRequest  the agent asks the person it acts for to sign a mandate
 *   CapIncreaseRequest          the agent asks the person to increase a mandate's caps
 *
 * Both are requests: the person approves (and signs the mandate) in the
 * browser, at the Commertize dashboard. The attestation signs no payment, no
 * transfer and no mandate. Any other payload (another primaryType, another
 * domain, an extra or missing field, a cap that is not a whole number of
 * cents, an "increase" that increases nothing) is refused before the key is read.
 *
 * Order in signerAttest: kill file first (~/.commertize/DISABLED, and
 * signing off until it was enabled on this machine), then the allow-list,
 * then the keychain. The private key is read from the keychain into this
 * process only to sign, and is never returned, printed or written.
 */

import { createHash, createPrivateKey, sign as ecSign } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalize } from "./canonical.ts";
import { KitConfigError } from "./client.ts";
import type { Keychain } from "./keychain.ts";
import { assertNotDisabled } from "./receiptsigner.ts";
import { needKeychain, SIGNER_KEY, signerInfoFromPrivate } from "./signer.ts";

export const ATTEST_DOMAIN = Object.freeze({ name: "Commertize device signer", version: "1" });

const CAP_KEYS = ["perCallUsdCents", "dailyUsdCents", "totalUsdCents"] as const;
type CapKey = (typeof CAP_KEYS)[number];
export type Caps = Record<CapKey, string>;

/** The two allow-listed schemas: primaryType -> its exact field list. */
const SCHEMAS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	MandateSignatureRequest: Object.freeze(["passportId", "level", "caps", "expiresAt", "nonce"]),
	CapIncreaseRequest: Object.freeze(["mandateId", "fromCaps", "toCaps", "nonce"]),
});
export const ATTEST_TYPES: readonly string[] = Object.freeze(Object.keys(SCHEMAS));

export const LEVELS: readonly string[] = Object.freeze(["L1", "L2"]);

export interface AttestPayload {
	domain: { name: string; version: string };
	primaryType: string;
	message: Record<string, unknown>;
}

export class NotAllowlistedError extends Error {
	readonly code = "TYPED_DATA_NOT_ALLOWLISTED";
	constructor(why: string) {
		super(`the device signer attests only a mandate signature request or a cap increase request; refused: ${why}`);
		this.name = "NotAllowlistedError";
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{64}$/;
const CENTS = /^(0|[1-9][0-9]{0,17})$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function exactKeys(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (!isPlain(v)) throw new NotAllowlistedError(`${what} is not a plain object`);
	const got = Object.keys(v);
	if (got.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(v, k)))
		throw new NotAllowlistedError(`${what} must have exactly the fields ${keys.join(", ")}`);
	return v;
}

/** Caps are whole cents as decimal strings (never a float), each > 0, per call <= daily <= total. */
export function checkCaps(v: unknown, what = "caps"): Caps {
	const c = exactKeys(v, CAP_KEYS, what);
	for (const k of CAP_KEYS) {
		const s = c[k];
		if (typeof s !== "string" || !CENTS.test(s) || s === "0") throw new NotAllowlistedError(`${what}.${k} must be a whole number of cents above 0, as a string`);
	}
	const [p, d, t] = CAP_KEYS.map((k) => BigInt(c[k] as string));
	if (p! > d! || d! > t!) throw new NotAllowlistedError(`${what}: per call <= daily <= total`);
	return c as Caps;
}

/** Throws NotAllowlistedError unless the payload is one of the two allow-listed schemas, exactly. */
export function checkAttestPayload(p: unknown, now: Date = new Date()): AttestPayload {
	const top = exactKeys(p, ["domain", "primaryType", "message"], "payload");
	const dom = exactKeys(top.domain, ["name", "version"], "domain");
	if (dom.name !== ATTEST_DOMAIN.name || dom.version !== ATTEST_DOMAIN.version) throw new NotAllowlistedError("domain is not the Commertize device signer domain");
	const t = top.primaryType;
	if (typeof t !== "string" || !Object.prototype.hasOwnProperty.call(SCHEMAS, t)) throw new NotAllowlistedError(`primaryType ${JSON.stringify(String(t)).slice(0, 80)}`);
	const m = exactKeys(top.message, SCHEMAS[t]!, "message");
	if (typeof m.nonce !== "string" || !NONCE.test(m.nonce)) throw new NotAllowlistedError("nonce must be 32 bytes of lowercase hex");
	if (t === "MandateSignatureRequest") {
		if (typeof m.passportId !== "string" || !UUID.test(m.passportId)) throw new NotAllowlistedError("passportId must be a UUID");
		if (typeof m.level !== "string" || !LEVELS.includes(m.level)) throw new NotAllowlistedError(`level must be one of ${LEVELS.join(", ")}`);
		checkCaps(m.caps);
		if (typeof m.expiresAt !== "string" || !ISO_Z.test(m.expiresAt) || !(Date.parse(m.expiresAt) > now.getTime()))
			throw new NotAllowlistedError("expiresAt must be a future UTC time (ISO 8601, Z)");
	} else {
		if (typeof m.mandateId !== "string" || !UUID.test(m.mandateId)) throw new NotAllowlistedError("mandateId must be a UUID");
		const from = checkCaps(m.fromCaps, "fromCaps");
		const to = checkCaps(m.toCaps, "toCaps");
		let increased = false;
		for (const k of CAP_KEYS) {
			const a = BigInt(from[k]);
			const b = BigInt(to[k]);
			if (b < a) throw new NotAllowlistedError(`toCaps.${k} is lower than fromCaps.${k}; lowering a cap is not an increase`);
			if (b > a) increased = true;
		}
		if (!increased) throw new NotAllowlistedError("toCaps increases no cap");
	}
	return top as unknown as AttestPayload;
}

/** The 32 bytes an attestation covers: SHA-256 of the canonical JSON of the checked payload. */
export function attestDigest(p: AttestPayload): Buffer {
	return createHash("sha256").update(canonicalize(p)).digest();
}

export interface Attestation {
	primaryType: string;
	digest: string;
	/** ECDSA P-256 over SHA-256 of the canonical payload, IEEE P1363 (r||s), base64url. */
	signature: string;
	fingerprint: string;
}

/**
 * A detached, data-only copy of the payload. Refuses a Proxy, an accessor (getter/setter) at any
 * depth, a symbol key, an array and any non-plain object, then copies through JSON. The check and
 * the signature both use ONLY this copy, so what is checked is exactly what is signed.
 */
export function snapshotPayload(v: unknown, depth = 0): unknown {
	if (depth > 4) throw new NotAllowlistedError("payload is nested too deeply");
	if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
	if (typeof v !== "object" || utilTypes.isProxy(v) || !isPlain(v)) throw new NotAllowlistedError("payload holds something other than plain data");
	if (Object.getOwnPropertySymbols(v).length > 0) throw new NotAllowlistedError("payload has a symbol key");
	// A null-prototype copy built with defineProperty: no key can reach a prototype setter.
	const out: Record<string, unknown> = Object.create(null);
	for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
		if (!("value" in d) || d.get !== undefined || d.set !== undefined) throw new NotAllowlistedError(`payload field ${JSON.stringify(k).slice(0, 40)} is an accessor`);
		if (k === "__proto__" || k === "constructor" || k === "prototype") throw new NotAllowlistedError(`payload has a reserved key ${k}`);
		Object.defineProperty(out, k, { value: snapshotPayload(d.value, depth + 1), enumerable: true, writable: true, configurable: true });
	}
	return JSON.parse(JSON.stringify(out));
}

export function signerAttest(kc: Keychain | undefined, home: string, payload: unknown, now: Date = new Date()): Attestation {
	assertNotDisabled(home);
	const p = checkAttestPayload(snapshotPayload(payload), now);
	const k = needKeychain(kc);
	const v = k.get(SIGNER_KEY);
	if (!v) throw new KitConfigError("no signer key stored: run signer init first");
	const info = signerInfoFromPrivate(v);
	const key = createPrivateKey({ key: Buffer.from(v, "base64url"), format: "der", type: "pkcs8" });
	const data = Buffer.from(canonicalize(p));
	const sig = ecSign("sha256", data, { key, dsaEncoding: "ieee-p1363" });
	return { primaryType: p.primaryType, digest: "sha256:" + attestDigest(p).toString("hex"), signature: sig.toString("base64url"), fingerprint: info.fingerprint };
}
