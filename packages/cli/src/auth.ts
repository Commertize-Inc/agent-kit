// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Split sign-in for agents that cannot hold a terminal open.
 *
 *   auth start            one call, prints { requestId, signinUrl, expiresIn }, exits.
 *                         You open the URL and approve in your browser.
 *   auth complete --wait  polls the request until approved, denied, expired or
 *                         the timeout. --no-wait checks once.
 *
 * Both routes are listed in the route table. Until the public API serves
 * them, each command stops before any network call (RouteMissingError).
 *
 * A credential returned on approval is handed to a sink (the OS keychain via
 * `configure`) and is never printed, logged or returned in a result.
 */

import { CommertizeClient, KitConfigError } from "./client.ts";

/** Hosts a sign-in URL may point at. Exact names: no suffix match, no port, https only. */
export const SIGNIN_HOSTS: ReadonlySet<string> = new Set(["commertize.com", "www.commertize.com", "app.commertize.com"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

export const AUTH_EXIT = { approved: 0, pending: 5, denied: 6, expired: 7, timeout: 8 } as const;
export type AuthStatus = keyof typeof AUTH_EXIT;

export interface AuthStartResult {
	requestId: string;
	signinUrl: string;
	expiresIn: number;
}

export function checkRequestId(id: unknown): string {
	if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new KitConfigError("request id must be 8-128 characters of A-Z a-z 0-9 _ -");
	return id;
}

/** The sign-in URL must be https on an exact Commertize host (http on loopback only when the API base is loopback). */
export function checkSigninUrl(raw: unknown, apiBase: string): string {
	if (typeof raw !== "string") throw new KitConfigError("sign-in URL missing from the answer");
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new KitConfigError("sign-in URL is not a URL");
	}
	const baseLoopback = LOOPBACK.has(new URL(apiBase).hostname);
	const loopbackOk = baseLoopback && LOOPBACK.has(u.hostname) && (u.protocol === "http:" || u.protocol === "https:");
	const ok = loopbackOk || (u.protocol === "https:" && SIGNIN_HOSTS.has(u.hostname) && u.port === "");
	if (!ok || u.username || u.password) throw new KitConfigError(`sign-in URL is not on a Commertize sign-in host; refusing to show it`);
	return u.toString();
}

export async function authStart(client: CommertizeClient, body: { agentAddress?: string } = {}): Promise<AuthStartResult> {
	const r = await client.call<Record<string, unknown>>("pairingStart", { body });
	const requestId = checkRequestId(r?.requestId);
	const signinUrl = checkSigninUrl(r?.signinUrl, client.env.baseUrl);
	const e = r?.expiresIn;
	if (typeof e !== "number" || !Number.isInteger(e) || e <= 0 || e > 3600) throw new KitConfigError("expiresIn must be whole seconds, 1-3600");
	return { requestId, signinUrl, expiresIn: e };
}

export type CredentialSink = (sessionToken: string) => Promise<{ stored: boolean; where: string }>;

export interface CompleteOptions {
	wait: boolean;
	/** Total wait budget. Default 10 minutes, cap 30. */
	timeoutMs?: number;
	/** Poll interval; floor 2 s. */
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	onCredential?: CredentialSink;
}

export interface AuthCompleteResult {
	requestId: string;
	status: AuthStatus;
	/** "stored": a sink kept it; "not_stored": approved with a credential but no sink; "none": no credential in the answer. */
	credential: "stored" | "not_stored" | "none";
	where?: string;
	polls: number;
}

const SERVER_STATES = new Set(["pending", "approved", "denied", "expired"]);

export async function authComplete(client: CommertizeClient, requestId: string, o: CompleteOptions): Promise<AuthCompleteResult> {
	checkRequestId(requestId);
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
	const now = o.now ?? Date.now;
	const interval = Math.max(2000, o.intervalMs ?? 5000);
	const budget = Math.min(30 * 60_000, Math.max(0, o.timeoutMs ?? 10 * 60_000));
	const start = now();
	let polls = 0;
	for (;;) {
		const r = await client.call<Record<string, unknown>>("pairingStatus", { params: { requestId } });
		polls++;
		const s = r?.status;
		if (typeof s !== "string" || !SERVER_STATES.has(s)) throw new KitConfigError("pairing status answer has an unknown status; refusing");
		if (s === "approved") {
			const tok = typeof r.sessionToken === "string" && r.sessionToken.trim() ? r.sessionToken.trim() : undefined;
			if (!tok) return { requestId, status: "approved", credential: "none", polls };
			if (!o.onCredential) return { requestId, status: "approved", credential: "not_stored", polls };
			const k = await o.onCredential(tok);
			return { requestId, status: "approved", credential: k.stored ? "stored" : "not_stored", where: k.where, polls };
		}
		if (s !== "pending" || !o.wait) return { requestId, status: s as AuthStatus, credential: "none", polls };
		if (now() - start + interval > budget) return { requestId, status: "timeout", credential: "none", polls };
		await sleep(interval);
	}
}
