// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `mandate revoke <id>`: ends one of the principal's mandates through the
 * live route POST /mandates/principal/:mid/revoke (session). Revoking only
 * narrows what an agent may do; it can never widen it.
 *
 * The route answers `{ ok: true }` whether or not anything changed (an
 * already-ended mandate is left as it is), so the answer is not taken as
 * proof. The kit reads the mandate before and after, and reports the state
 * it reads back:
 *
 *   already ended before   -> nothing is sent; exit 0 with the status read
 *   ended after the POST   -> exit 0 with before and after
 *   still live after it    -> exit 1: the server said ok but the mandate is
 *                             not ended (nothing is claimed)
 *
 * `--dry-run` does the first read only.
 */

import { CommertizeClient } from "./client.ts";
import { mandateShow, UnexpectedAnswerError } from "./whoami.ts";

/** Statuses after which a mandate has ended (backend lifecycle end()). */
export const ENDED: ReadonlySet<string> = new Set(["revoked", "expired", "terminated"]);

function state(m: Record<string, unknown>) {
	return { status: typeof m.status === "string" ? m.status : null, endedAt: typeof m.endedAt === "string" ? m.endedAt : null };
}

const ended = (s: { status: string | null; endedAt: string | null }) => (s.status !== null && ENDED.has(s.status)) || s.endedAt !== null;

export async function mandateRevoke(client: CommertizeClient, mandateId: string, dryRun: boolean) {
	const before = state((await mandateShow(client, mandateId)).mandate as Record<string, unknown>);
	if (ended(before)) return { mandateId, sent: false, already_ended: true, before, after: before };
	if (dryRun) return { mandateId, sent: false, already_ended: false, before, after: null };
	await client.call("mandateRevoke", { params: { mid: mandateId }, body: {} });
	const after = state((await mandateShow(client, mandateId)).mandate as Record<string, unknown>);
	if (!ended(after))
		throw new UnexpectedAnswerError(`the revoke route answered ok, but mandate ${mandateId} still reads as ${after.status ?? "unknown"}; nothing is claimed`);
	return { mandateId, sent: true, already_ended: false, before, after };
}
