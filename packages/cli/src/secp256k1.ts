// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * secp256k1 for CAS receipt signatures (CAS-1 section 5.1.1), with no dependency.
 *
 * - Points k*G come from Node's ECDH (OpenSSL), not from code here.
 * - Nonces are RFC 6979 (HMAC-SHA256), so a signature is reproducible byte for byte and never
 *   depends on a random source.
 * - Every signature is checked by recovering its signer before it is returned (recoverAddress,
 *   the affine arithmetic below, ported from the cas-spec reference verifier).
 *
 * Timing: the BigInt arithmetic is not constant time. The key lives on the operator's machine and
 * any process that could time this could read the key from the keychain anyway (keychain.ts).
 */

import { createECDH, createHmac } from "node:crypto";
import { keccak256, toChecksumAddress } from "./keccak.ts";

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = N >> 1n;
const G = { x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n };

type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint): bigint => {
	const r = a % m;
	return r < 0n ? r + m : r;
};
function powMod(b: bigint, e: bigint, m: bigint): bigint {
	let r = 1n;
	b = mod(b, m);
	while (e > 0n) {
		if (e & 1n) r = (r * b) % m;
		b = (b * b) % m;
		e >>= 1n;
	}
	return r;
}
const inv = (a: bigint, m: bigint): bigint => powMod(a, m - 2n, m);

function add(a: Point, b: Point): Point {
	if (a === null) return b;
	if (b === null) return a;
	if (a.x === b.x) {
		if (mod(a.y + b.y, P) === 0n) return null;
		const l = mod(3n * a.x * a.x * inv(2n * a.y, P), P);
		const x = mod(l * l - 2n * a.x, P);
		return { x, y: mod(l * (a.x - x) - a.y, P) };
	}
	const l = mod((b.y - a.y) * inv(b.x - a.x, P), P);
	const x = mod(l * l - a.x - b.x, P);
	return { x, y: mod(l * (a.x - x) - a.y, P) };
}
function mul(p: Point, k: bigint): Point {
	let r: Point = null;
	let q = p;
	k = mod(k, N);
	while (k > 0n) {
		if (k & 1n) r = add(r, q);
		q = add(q, q);
		k >>= 1n;
	}
	return r;
}

const big = (b: Uint8Array): bigint => (b.length ? BigInt("0x" + Buffer.from(b).toString("hex")) : 0n);
const be32 = (v: bigint): Buffer => Buffer.from(v.toString(16).padStart(64, "0"), "hex");

function addressOfPoint(q: Point): string {
	if (q === null) throw new Error("point at infinity");
	return toChecksumAddress(Buffer.from(keccak256(Buffer.concat([be32(q.x), be32(q.y)]))).subarray(12).toString("hex"));
}

/** k*G through OpenSSL: returns the affine point. */
function baseMul(k: bigint): { x: bigint; y: bigint } {
	const e = createECDH("secp256k1");
	e.setPrivateKey(be32(k));
	const pub = e.getPublicKey(); // 0x04 || X || Y
	return { x: big(pub.subarray(1, 33)), y: big(pub.subarray(33, 65)) };
}

/** Recovers the signer address of a 65-byte r || s || v (v 27/28) signature over a 32-byte digest. Throws on any invalid form. */
export function recoverAddress(digest: Uint8Array, sig: Uint8Array): string {
	if (digest.length !== 32 || sig.length !== 65) throw new Error("bad lengths");
	const r = big(sig.subarray(0, 32));
	const s = big(sig.subarray(32, 64));
	const v = sig[64]! - 27;
	if (v !== 0 && v !== 1) throw new Error("bad recovery id");
	if (r <= 0n || r >= N || s <= 0n || s > HALF_N) throw new Error("r or s out of range");
	const ySq = mod(r * r * r + 7n, P);
	let y = powMod(ySq, (P + 1n) / 4n, P);
	if (mod(y * y, P) !== ySq) throw new Error("r is not on the curve");
	if ((y & 1n) !== BigInt(v)) y = P - y;
	const e = mod(big(digest), N);
	const rInv = inv(r, N);
	return addressOfPoint(add(mul({ x: r, y }, mod(s * rInv, N)), mul(G, mod(-e * rInv, N))));
}

const hmac = (key: Uint8Array, ...parts: Uint8Array[]): Buffer => {
	const h = createHmac("sha256", key);
	for (const p of parts) h.update(p);
	return h.digest();
};

/** ECDSA over a 32-byte digest: RFC 6979 nonce (HMAC-SHA256), low s, v 27/28. Self-checked by recovery. */
export function signDigest(digest: Uint8Array, priv: bigint, expectAddress: string): Buffer {
	if (digest.length !== 32) throw new Error("digest must be 32 bytes");
	if (priv < 1n || priv >= N) throw new Error("private key out of range");
	const x = be32(priv);
	const e = mod(big(digest), N);
	const h1 = be32(e);
	let V: Buffer = Buffer.alloc(32, 1);
	let K: Buffer = Buffer.alloc(32, 0);
	K = hmac(K, V, Uint8Array.of(0), x, h1);
	V = hmac(K, V);
	K = hmac(K, V, Uint8Array.of(1), x, h1);
	V = hmac(K, V);
	for (;;) {
		V = hmac(K, V);
		const k = big(V);
		if (k >= 1n && k < N) {
			const R = baseMul(k);
			const r = mod(R.x, N);
			let s = mod(inv(k, N) * (e + r * priv), N);
			if (r !== 0n && s !== 0n && R.x < N) {
				let v = Number(R.y & 1n);
				if (s > HALF_N) {
					s = N - s;
					v ^= 1;
				}
				const sig = Buffer.concat([be32(r), be32(s), Buffer.of(27 + v)]);
				// Fail closed: a signature that does not recover to the key's own address is never returned.
				if (recoverAddress(digest, sig).toLowerCase() !== expectAddress.toLowerCase()) throw new Error("signature self-check failed");
				return sig;
			}
		}
		K = hmac(K, V, Uint8Array.of(0));
		V = hmac(K, V);
	}
}
