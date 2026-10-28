// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `identity show`: one of the principal's agents (its passport) and that
 * passport's KYA check record. Two reads: GET /mandates/principal/agents,
 * then GET /kya/passports/:pid/checks. Read only.
 *
 * A 404 from the check route (switched off on the deployment, or no record
 * for this passport there) is reported as `checks: null` with the reason,
 * never as "no checks": an empty list and an unavailable record differ.
 * Check rows are never dropped: a row without a result refuses the answer.
 */

import { ApiError, CommertizeClient, KitConfigError } from "./client.ts";
import { AGENTS_PAGE_MAX, listAgents, NotFoundError, UnexpectedAnswerError } from "./whoami.ts";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pages of agents read to find the one asked for (50 each). */
export const IDENTITY_SCAN_PAGES = 20;

/** One served KYA check. Only `result` is required; any other missing field is null, never a reason to drop the row. */
export interface KyaCheckRow {
	id: string | null;
	checkId: string | null;
	result: string;
	policyVersion: string | null;
	checkedAt: string | null;
}

/** Finds one of the principal's agents by 0x address or passport id, following pages (bounded). */
export async function findAgent(client: CommertizeClient, ref: string) {
	const byAddress = ADDRESS.test(ref);
	if (!byAddress && !UUID.test(ref)) throw new KitConfigError("an agent is named by its 0x address or its passport id");
	let cursor: string | undefined;
	for (let page = 0; page < IDENTITY_SCAN_PAGES; page++) {
		const r = await listAgents(client, { limit: AGENTS_PAGE_MAX, cursor });
		const hit = r.agents.find((a) => (byAddress ? a.agentAddress.toLowerCase() === ref.toLowerCase() : a.passportId.toLowerCase() === ref.toLowerCase()));
		if (hit) return hit;
		if (!r.next_cursor) break;
		cursor = r.next_cursor;
	}
	throw new NotFoundError("agent", `${ref} is not one of the agents under your account`);
}

export async function identityShow(client: CommertizeClient, ref: string) {
	const a = await findAgent(client, ref);
	let checks: KyaCheckRow[] | null = null;
	let checks_note: string | null = null;
	try {
		const r = await client.call<{ checks?: unknown }>("kyaChecks", { params: { pid: a.passportId } });
		if (!Array.isArray(r?.checks)) throw new UnexpectedAnswerError("GET /kya/passports/:pid/checks answered without a checks list; refusing");
		// Every row is kept: dropping one could hide a failed check. A missing field becomes null;
		// a row without a result cannot be shown honestly, so the whole answer is refused.
		const str = (v: unknown) => (typeof v === "string" ? v : null);
		checks = r.checks.map((c: Record<string, unknown> | null) => {
			if (typeof c?.result !== "string") throw new UnexpectedAnswerError("a KYA check row has no result; refusing rather than hiding it");
			return { id: str(c.id), checkId: str(c.checkId), result: c.result, policyVersion: str(c.policyVersion), checkedAt: str(c.checkedAt) };
		});
	} catch (e) {
		if (!(e instanceof ApiError) || e.status !== 404) throw e;
		checks_note = "the KYA check record answered 404: it is not available for this passport on this deployment";
	}
	return {
		passport: {
			passportId: a.passportId,
			agentAddress: a.agentAddress,
			kyaStatus: a.kyaStatus,
			createdAt: typeof a.createdAt === "string" ? a.createdAt : null,
			revokedAt: typeof a.revokedAt === "string" ? a.revokedAt : null,
		},
		checks,
		checks_note,
	};
}
