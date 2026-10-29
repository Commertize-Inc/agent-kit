// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Local limits on agent-declared text (name, description, homepage), applied
 * before anything is sent. This is third-party text: the kit never renders it
 * in its own voice. Values are NFC-normalized, then counted by code point.
 * Control (Cc) and format (Cf: bidi overrides, zero-width) characters are
 * refused outright, so a name cannot reorder or hide what is shown next to it.
 */

/** A local limit refused the value: the CLI maps it to a usage error (exit 2). */
export class AgentTextError extends Error {}

export const AGENT_TEXT_LIMITS = { name: 64, description: 280, homepage: 2048 } as const;
export type AgentTextField = keyof typeof AGENT_TEXT_LIMITS;

const BAD_CHARS = /[\p{Cc}\p{Cf}]/u;

export function checkAgentText(field: AgentTextField, raw: string): string {
	const v = raw.normalize("NFC");
	if (BAD_CHARS.test(v)) throw new AgentTextError(`--${field} has a control or format character`);
	const n = [...v].length;
	if (n < 1 || n > AGENT_TEXT_LIMITS[field]) throw new AgentTextError(`--${field} must be 1 to ${AGENT_TEXT_LIMITS[field]} characters`);
	if (field === "homepage") {
		let u: URL;
		try {
			u = new URL(v);
		} catch {
			throw new AgentTextError("--homepage must be an https:// URL");
		}
		if (u.protocol !== "https:" || u.username || u.password) throw new AgentTextError("--homepage must be an https:// URL with no user or password");
	}
	return v;
}

/** Checks every agent-declared field that was passed; returns the normalized values. */
export function checkAgentFields(values: Record<string, unknown>): Partial<Record<AgentTextField, string>> {
	const out: Partial<Record<AgentTextField, string>> = {};
	for (const f of Object.keys(AGENT_TEXT_LIMITS) as AgentTextField[]) {
		const v = values[f];
		if (typeof v === "string") out[f] = checkAgentText(f, v);
	}
	return out;
}
