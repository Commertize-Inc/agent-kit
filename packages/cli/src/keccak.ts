// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Keccak-256 (the original Keccak padding 0x01, as Ethereum uses; not
 * NIST SHA3-256, which pads 0x06). Node's crypto has no Keccak, and this kit
 * takes no dependencies, so this is the reference sponge over 64-bit lanes
 * held as BigInt. It is used only to derive an address from a public key and
 * for the EIP-55 checksum: small inputs, so speed does not matter.
 * Pinned by known vectors in the tests.
 */

const MASK = (1n << 64n) - 1n;

const RC: bigint[] = [
	0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
	0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
	0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
	0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y], indexed x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

const rotl = (v: bigint, n: number): bigint => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(s: bigint[]): void {
	for (let round = 0; round < 24; round++) {
		// theta
		const c = [0, 1, 2, 3, 4].map((x) => s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!);
		for (let x = 0; x < 5; x++) {
			const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
			for (let y = 0; y < 25; y += 5) s[x + y] = s[x + y]! ^ d;
		}
		// rho and pi: B[y][2x+3y] = rot(A[x][y], r[x][y])
		const b = new Array<bigint>(25).fill(0n);
		for (let x = 0; x < 5; x++)
			for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, ROT[x + 5 * y]!);
		// chi
		for (let x = 0; x < 5; x++)
			for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK & b[((x + 2) % 5) + 5 * y]!);
		// iota
		s[0] = s[0]! ^ RC[round]!;
	}
}

/** Keccak-256 of the given bytes. */
export function keccak256(data: Uint8Array): Uint8Array {
	const rate = 136; // bytes, for a 256-bit output
	const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
	padded.set(data);
	padded[data.length] = (padded[data.length] ?? 0) ^ 0x01;
	padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80;
	const s = new Array<bigint>(25).fill(0n);
	for (let off = 0; off < padded.length; off += rate) {
		for (let i = 0; i < rate / 8; i++) {
			let lane = 0n;
			for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]!);
			s[i] = s[i]! ^ lane;
		}
		keccakF(s);
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((s[i]! >> BigInt(8 * j)) & 0xffn);
	return out;
}

/** EIP-55 mixed-case checksum of a 20-byte address given as 40 hex characters (any case). */
export function toChecksumAddress(hex40: string): string {
	const lower = hex40.toLowerCase();
	if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error("not a 20-byte address");
	const h = Buffer.from(keccak256(Buffer.from(lower, "utf8"))).toString("hex");
	let out = "0x";
	for (let i = 0; i < 40; i++) out += parseInt(h[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
	return out;
}
