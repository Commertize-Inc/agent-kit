// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `serve` (K-6b): one signed CAS receipt per settled call.
 *
 * The receipt goes through the kit's existing receipt signer path: a ReceiptLog built by
 * agentKeyReceiptLog (receiptsigner.ts). Signing is off by default, and the kill file is checked
 * before the log is built and again before every signature (guardSigner). While signing is off,
 * no receipt is issued; OperatorSeller then answers with `X-Commertize-Receipt: none`, and the
 * serve kill-file check (assertServeEnabled) refuses new calls before any challenge.
 *
 * What the receipt records (only hashes, never bodies):
 *   action    verb "file", object_ref "<network>:<settlement tx>"
 *   evidence  sha256 of { serviceId, payer, payTo, amount, network, transaction, requestHash, responseHash }
 *   refs      [requestHash, responseHash]: either party recomputes them from its own copy of the bytes
 * The amount is inside the hashed evidence, so the receipt text itself carries no amount.
 */

import { sha256, type Receipt, type ReceiptLog } from "./cas.ts";
import type { SellerDeps } from "./seller.ts";

export interface SettledCall {
	payer: string;
	amount: bigint;
	transaction: string;
	requestBody: Buffer;
	responseBody: string;
}

/** The evidence object whose hash a serve receipt records. Exported so a verifier can rebuild it. */
export function serveEvidence(o: { serviceId: string; payTo: string; network: string }, s: SettledCall) {
	return {
		serviceId: o.serviceId,
		payer: s.payer.toLowerCase(),
		payTo: o.payTo.toLowerCase(),
		amount: s.amount.toString(),
		network: o.network,
		transaction: s.transaction.toLowerCase(),
		requestHash: sha256(s.requestBody),
		responseHash: sha256(s.responseBody),
	};
}

/** The onSettled hook for OperatorSeller: records one receipt per settled call in `log`. */
export function serveReceiptHook(log: ReceiptLog, o: { serviceId: string; payTo: string; network: string }, sink?: (r: Receipt) => void): NonNullable<SellerDeps["onSettled"]> {
	return async (s) => {
		const ev = serveEvidence(o, s);
		const r = await log.record({ verb: "file", objectRef: `${o.network}:${ev.transaction}`, evidence: ev, refs: [ev.requestHash, ev.responseHash] });
		sink?.(r);
		return { "X-Commertize-Receipt": r.receipt_id, "X-Commertize-Receipt-Hash": r.hash };
	};
}
