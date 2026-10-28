// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Exit codes and the hand-back every refusal and every terminal state carries.
 *
 * A hand-back is `{ reason, by, url }`:
 *   reason  a stable code to branch on (never parse the wording)
 *   by      who acts next: "principal" (the person the agent works for) or "agent"
 *   url     where that action happens
 *
 * The URL comes from the fixed table below and from nowhere else: never from
 * a server response, a file or a flag. Each URL is either a page in the
 * principal's own Commertize dashboard or this kit's public documentation.
 * No hand-back names a command, so a refusal can never hand an agent a way
 * to widen its own access: anything that grants access (signing in, a
 * mandate, a credential) is the principal's step, at the principal's URL.
 */

export const EXIT = {
	ok: 0,
	error: 1,
	usage: 2,
	registered_mandate_not_open: 3,
	not_open: 4,
	pending: 5,
	denied: 6,
	expired: 7,
	timeout: 8,
	busy: 9,
	task_rejected: 10,
	task_expired: 11,
	task_cancelled: 12,
	task_closed: 13,
	task_removed: 14,
	skill_drift: 15,
	not_found: 16,
	// Reserved for fail-closed classes; no command returns them in this release. Never reuse a code.
	mandate_refused: 17,
	state_unreadable: 18,
	frozen: 19,
	upstream_unavailable: 20,
	aborted: 130,
} as const;

/** The principal's dashboard. */
export const PRINCIPAL_APP = "https://app.commertize.com";
/** This kit's public documentation. */
export const KIT_DOCS = "https://github.com/Commertize-Inc/agent-kit#readme";
/** Every host a hand-back URL may name. */
export const HAND_BACK_HOSTS: ReadonlySet<string> = new Set(["app.commertize.com", "github.com"]);

type By = "principal" | "agent";
const P = (path: string) => ({ by: "principal" as By, url: PRINCIPAL_APP + path });
const A = { by: "agent" as By, url: KIT_DOCS };

export const HAND_BACK = {
	// refusals
	usage: A,
	config: A,
	session_missing: P("/"),
	api_key_missing: P("/profile"),
	host_not_allowed: P("/"),
	route_not_open: A,
	serve_not_open: A,
	api_error: A,
	internal: A,
	busy: A,
	drain_source_changed: A,
	signin_pending: P("/agents"),
	signin_denied: P("/agents"),
	signin_expired: A,
	signin_timeout: A,
	credential_not_stored: P("/profile"),
	// The principal sets the mandate up: the create page, not the list.
	mandate_not_open: P("/mandates/new"),
	mandate_not_found: P("/mandates"),
	agent_not_found: P("/agents"),
	skill_drift: A,
	// terminal states
	task_completed: A,
	task_rejected: A,
	task_expired: A,
	task_cancelled: A,
	task_closed: A,
	task_removed: A,
	stream_stopped: A,
	aborted: A,
} as const satisfies Record<string, { by: By; url: string }>;

export type Reason = keyof typeof HAND_BACK;

export interface HandBack {
	reason: Reason;
	by: By;
	url: string;
}

/** The only constructor. It takes a reason code and nothing else, so no caller can supply a URL. */
export function handBack(reason: Reason): HandBack {
	if (!Object.hasOwn(HAND_BACK, reason)) throw new Error(`unknown hand-back reason ${String(reason)}`);
	const h = HAND_BACK[reason];
	return { reason, by: h.by, url: h.url };
}

/** Final task states and the exit code and reason each ends a watch with. */
export const TASK_FINAL: Readonly<Record<string, { exit: number; reason: Reason }>> = Object.freeze({
	completed: { exit: EXIT.ok, reason: "task_completed" },
	rejected: { exit: EXIT.task_rejected, reason: "task_rejected" },
	expired: { exit: EXIT.task_expired, reason: "task_expired" },
	cancelled: { exit: EXIT.task_cancelled, reason: "task_cancelled" },
	closed: { exit: EXIT.task_closed, reason: "task_closed" },
});

/** The final-state entry for a status, or undefined (own keys only: "toString" is not a state). */
export function taskFinal(status: unknown): { exit: number; reason: Reason } | undefined {
	return typeof status === "string" && Object.hasOwn(TASK_FINAL, status) ? TASK_FINAL[status] : undefined;
}
