// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

// Fetches the CAS receipt signature vectors from Commertize-Inc/cas-spec at a pinned commit and
// verifies them against the sha256 integrity pin before anything uses them. The vectors are never
// committed to this repository (no copy, no encoded copy). Used by the K-4b tests and by the CI step:
//
//   node --experimental-strip-types packages/cli/test/receipt-fixture.ts
//     exit 0 when the pinned vectors fetch and match; exit 1 with the reason otherwise
//
// The pin (test/fixtures/cas-1.0-receipt-secp256k1.pin.json):
//   url        raw URL by commit sha (never a branch, so the content cannot move)
//   integrity  "sha256-" + base64 of the file's SHA-256 (Subresource Integrity form)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PIN_FILE = new URL("./fixtures/cas-1.0-receipt-secp256k1.pin.json", import.meta.url);

export interface ReceiptPin {
	source: string;
	commit: string;
	url: string;
	integrity: string;
	seed: string;
}

export interface ReceiptVectorCase {
	name: string;
	keyIndex?: number;
	hash: string;
	digest: string | null;
	signature: { alg: string; key_id: string; sig: string };
	sigHex: string | null;
	expected: { valid: boolean; reason: string };
}

export function readPin(): ReceiptPin {
	const pin = JSON.parse(readFileSync(PIN_FILE, "utf8")) as ReceiptPin;
	if (!/^[0-9a-f]{40}$/.test(pin.commit)) throw new Error("pin: commit is not a 40-hex commit sha");
	const expectUrl = `https://raw.githubusercontent.com/Commertize-Inc/cas-spec/${pin.commit}/conformance/vectors/cas-1.0-receipt-secp256k1.json`;
	if (pin.url !== expectUrl) throw new Error("pin: url must be the raw URL of the pinned commit");
	if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(pin.integrity)) throw new Error("pin: integrity is not sha256-<base64>");
	return pin;
}

/** Fetches and verifies. Throws an Error whose message starts with "fixture unavailable:" on any failure. */
export async function loadReceiptVectors(fetchImpl: typeof fetch = fetch): Promise<{ pin: ReceiptPin; raw: Buffer; vectors: ReceiptVectorCase[] }> {
	const pin = readPin();
	let raw: Buffer;
	try {
		const res = await fetchImpl(pin.url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		raw = Buffer.from(await res.arrayBuffer());
	} catch (e) {
		throw new Error(`fixture unavailable: could not fetch ${pin.url} (${(e as Error).message ?? e}) [requires-network]`);
	}
	const got = "sha256-" + createHash("sha256").update(raw).digest("base64");
	if (got !== pin.integrity) throw new Error(`fixture unavailable: integrity mismatch for ${pin.url} (got ${got}, pinned ${pin.integrity})`);
	return { pin, raw, vectors: (JSON.parse(raw.toString("utf8")) as { vectors: ReceiptVectorCase[] }).vectors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		const { pin, vectors } = await loadReceiptVectors();
		console.log(`receipt vectors: ok (${vectors.length} vectors, cas-spec ${pin.commit.slice(0, 8)}, ${pin.integrity})`);
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
