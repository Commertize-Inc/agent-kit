// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Read-only views of the principal's own account:
 *
 *   whoami            one read: the principal's company check, its agents and their mandates,
 *                     which credentials are present (never their values), and the receipts in
 *                     a local log you name. Payees and spend to date have no public route: they
 *                     are reported as Not open, never estimated.
 *   agents            the principal's agents, one page at a time
 *   mandate show <id> one mandate, found among the principal's own agents
 *
 * All three use GET /mandates/principal/agents (live, session). Nothing here writes.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { CommertizeClient, KitConfigError } from "./client.ts";
import { validateReceipt } from "./cas.ts";

/** The company-check states the API serves (principal_kyb_status). Anything else is read as "unknown". */
export const KYB_STATES = ["verified", "manual_review", "not_verified", "unknown"] as const;
export type KybState = (typeof KYB_STATES)[number];

/**
 * The approved display strings for the company check. Only "verified" with a
 * date shows "KYB verified"; only "manual_review" with a date shows
 * "Reviewed by Commertize"; every other case shows no label.
 */
export function kybLabel(status: unknown, asOf: unknown): string | null {
	if (typeof asOf !== "string" || !asOf || Number.isNaN(Date.parse(asOf))) return null;
	if (status === "verified") return "KYB verified";
	if (status === "manual_review") return "Reviewed by Commertize";
	return null;
}

export function kybView(body: Record<string, unknown>): { status: KybState; as_of: string | null; label: string | null } {
	const s = (KYB_STATES as readonly unknown[]).includes(body.principal_kyb_status) ? (body.principal_kyb_status as KybState) : "unknown";
	const asOf = typeof body.principal_kyb_as_of === "string" ? body.principal_kyb_as_of : null;
	return { status: s, as_of: asOf, label: kybLabel(s, asOf) };
}

export interface AgentRow {
	passportId: string;
	agentAddress: string;
	kyaStatus: string;
	mandates: Record<string, unknown>[];
	[k: string]: unknown;
}

interface AgentsPage {
	nextCursor?: string | null;
	agents?: unknown;
	[k: string]: unknown;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const AGENTS_PAGE_MAX = 50;
/** mandate show reads at most this many pages (50 agents each) before it stops looking. */
export const MANDATE_SCAN_PAGES = 20;

function rows(p: AgentsPage): AgentRow[] {
	const list = Array.isArray(p.agents) ? p.agents : [];
	// The passport id goes into URLs (identity show) and the address into RPC calls: both are
	// pattern-checked here, so a row like passportId ".." never reaches a request.
	return list.filter(
		(a): a is AgentRow =>
			typeof a?.passportId === "string" &&
			UUID.test(a.passportId) &&
			typeof a?.agentAddress === "string" &&
			ADDRESS.test(a.agentAddress) &&
			typeof a?.kyaStatus === "string" &&
			Array.isArray(a?.mandates)
	);
}

/** A server answer that breaks the route's contract. The command stops; nothing from the answer is passed on. */
export class UnexpectedAnswerError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "UnexpectedAnswerError";
	}
}

export class NotFoundError extends Error {
	readonly what: "agent" | "mandate";
	constructor(what: "agent" | "mandate", msg: string) {
		super(msg);
		this.name = "NotFoundError";
		this.what = what;
	}
}

function needSession(client: CommertizeClient, cmd: string): void {
	if (!client.env.sessionToken) throw new KitConfigError(`${cmd} needs COMMERTIZE_SESSION_TOKEN (your own session)`);
}

export async function listAgents(client: CommertizeClient, o: { limit?: number; cursor?: string } = {}) {
	needSession(client, "agents");
	const limit = o.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > AGENTS_PAGE_MAX) throw new KitConfigError(`--limit is 1-${AGENTS_PAGE_MAX}`);
	if (o.cursor !== undefined && !UUID.test(o.cursor)) throw new KitConfigError("--cursor is an agent id from a previous page");
	const p = await client.call<AgentsPage>("principalAgents", { query: { limit: String(limit), ...(o.cursor ? { cursor: o.cursor } : {}) } });
	const agents = rows(p ?? {});
	// The cursor goes into a printed next_step command line: anything but null or a UUID is refused, never echoed.
	const nc = p?.nextCursor;
	if (nc !== undefined && nc !== null && (typeof nc !== "string" || !UUID.test(nc)))
		throw new UnexpectedAnswerError("GET /mandates/principal/agents answered a nextCursor that is not an agent id; refusing");
	return { agents, next_cursor: typeof nc === "string" ? nc : null, kyb: kybView(p ?? {}) };
}

export async function mandateShow(client: CommertizeClient, mandateId: string) {
	needSession(client, "mandate show");
	if (!UUID.test(mandateId)) throw new KitConfigError("mandate id is a UUID");
	let cursor: string | undefined;
	for (let page = 0; page < MANDATE_SCAN_PAGES; page++) {
		const r = await listAgents(client, { limit: AGENTS_PAGE_MAX, cursor });
		for (const a of r.agents)
			for (const m of a.mandates)
				if (typeof m?.mandateId === "string" && m.mandateId.toLowerCase() === mandateId.toLowerCase())
					return { mandate: m, agent: { passportId: a.passportId, agentAddress: a.agentAddress, kyaStatus: a.kyaStatus }, pages_read: page + 1 };
		if (!r.next_cursor) throw new NotFoundError("mandate", `no mandate ${mandateId} under your account`);
		cursor = r.next_cursor;
	}
	throw new NotFoundError("mandate", `no mandate ${mandateId} in your first ${MANDATE_SCAN_PAGES * AGENTS_PAGE_MAX} agents`);
}

export const RECEIPTS_MAX_BYTES = 64 * 1024 * 1024;

/** Counts CAS receipts in a local NDJSON log: valid ones, and lines that are not valid receipts. */
export function countReceipts(file: string): { file: string; valid: number; invalid: number } {
	if (!statSync(file).isFile()) throw new KitConfigError(`${file} is not a regular file`); // a FIFO would block the open forever
	const fd = openSync(file, "r");
	let text: string;
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new KitConfigError(`${file} is not a regular file`);
		if (st.size > RECEIPTS_MAX_BYTES) throw new KitConfigError(`${file} is larger than ${RECEIPTS_MAX_BYTES} bytes`);
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < st.size) {
			const n = readSync(fd, buf, off, st.size - off, off);
			if (n === 0) break;
			off += n;
		}
		text = buf.subarray(0, off).toString("utf8");
	} finally {
		closeSync(fd);
	}
	let valid = 0;
	let invalid = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let r: unknown;
		try {
			r = JSON.parse(line);
		} catch {
			invalid++;
			continue;
		}
		if (validateReceipt(r).length === 0) valid++;
		else invalid++;
	}
	return { file, valid, invalid };
}

export type CredentialSource = "environment" | "keychain" | "absent";

export interface WhoamiOptions {
	/** Which of the principal's agents is "me" (0x address). Without it, the only agent if there is exactly one. */
	agentAddress?: string;
	receiptsFile?: string;
	credentials: { session_token: CredentialSource; api_key: CredentialSource };
}

/** One read of GET /mandates/principal/agents (first 50 agents). */
export async function whoami(client: CommertizeClient, o: WhoamiOptions) {
	needSession(client, "whoami");
	if (o.agentAddress !== undefined && !ADDRESS.test(o.agentAddress)) throw new KitConfigError("--agent must be a 0x-prefixed 20-byte address");
	const r = await listAgents(client, { limit: AGENTS_PAGE_MAX });
	let agent: AgentRow | null = null;
	if (o.agentAddress) {
		agent = r.agents.find((a) => a.agentAddress.toLowerCase() === o.agentAddress!.toLowerCase()) ?? null;
		if (!agent)
			throw new NotFoundError(
				"agent",
				`${o.agentAddress} is not registered under your account${r.next_cursor ? ` (first ${AGENTS_PAGE_MAX} agents read)` : ""}`
			);
	} else if (r.agents.length === 1 && !r.next_cursor) agent = r.agents[0]!;
	return {
		principal: { kyb: r.kyb },
		agent: agent ? { passportId: agent.passportId, agentAddress: agent.agentAddress, kyaStatus: agent.kyaStatus } : null,
		mandates: agent ? agent.mandates : [],
		agents_count: r.agents.length,
		agents_truncated: r.next_cursor !== null,
		payees: { status: "Not open", value: null },
		spend_to_date: { status: "Not open", value: null },
		receipts: o.receiptsFile ? countReceipts(o.receiptsFile) : { status: "not counted: pass --receipts <file>", value: null },
		credentials: o.credentials,
	};
}
