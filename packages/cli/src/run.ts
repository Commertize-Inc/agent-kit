// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { CommertizeClient, KitConfigError, readEnv, type CallOptions } from "./client.ts";
import { ReceiptLog, ed25519Signer } from "./cas.ts";
import type { ModelSeam, Template, TemplateResult } from "./kit.ts";
import { agentKeyReceiptLog, assertNotDisabled, ensureDefaultDisabled, guardSigner } from "./receiptsigner.ts";
import { osKeychain, type Keychain } from "./keychain.ts";
import { ROUTES, type Route, type RouteId } from "./routes.ts";
import { homedir } from "node:os";

/**
 * A client that checks the kill switch (~/.commertize/DISABLED) before every write (non-GET) call.
 * Reads are not blocked: they change nothing.
 */
export class KillSwitchClient extends CommertizeClient {
	readonly #home: string;
	readonly #routes: Readonly<Record<string, Route>>;
	constructor(base: CommertizeClient, home: string) {
		const inner = base as unknown as { fetchImpl: typeof fetch; routes: Readonly<Record<string, Route>> };
		super(base.env, inner.fetchImpl, inner.routes ?? ROUTES);
		this.#home = home;
		this.#routes = inner.routes ?? ROUTES;
	}
	override async call<T = unknown>(id: RouteId, opts: CallOptions = {}): Promise<T> {
		// Unknown route ids count as writes: the kill switch is checked rather than guessed past.
		const route = this.#routes[id];
		if (!route || route.method !== "GET") assertNotDisabled(this.#home);
		return super.call<T>(id, opts);
	}
}

/**
 * Runs a template once on your machine, with ids and your signing seed read
 * from your environment. Prints the result; writes nothing to disk.
 *
 *  COMMERTIZE_MANDATE_ID, COMMERTIZE_AGENT_ID, COMMERTIZE_AGENT_KEY_ID  your own CAS ids
 *  COMMERTIZE_AGENT_SEED  raw 32-byte ed25519 seed, base64url (or pass your own Signer via runTemplate)
 *  COMMERTIZE_RECEIPT_SIGNER  "ed25519" (default) or "agent-key" (the agent key in the OS keychain)
 *
 * The kill switch stops the run before anything else, in both modes; it is checked again before every
 * signature and before every write call. Signing is off until the person enables it on this machine.
 *
 * Exit code: 0 done, 3 done but a step stopped on a route that is Not open.
 */
export async function runOnce(
	template: Template,
	model: ModelSeam,
	env: Record<string, string | undefined> = process.env,
	// One non-default API host you name in code; never read from the environment.
	allowHost?: string,
	// Test seams: home directory and keychain. Not reachable from the environment.
	seams: { home?: string; keychain?: Keychain; client?: CommertizeClient } = {}
): Promise<TemplateResult> {
	const need = (k: string): string => {
		const v = env[k]?.trim();
		if (!v) throw new KitConfigError(`${k} is not set`);
		return v;
	};
	const raw = env.COMMERTIZE_RECEIPT_SIGNER;
	if (raw !== undefined && !raw.trim()) throw new KitConfigError("COMMERTIZE_RECEIPT_SIGNER is set but empty: unset it, or choose a mode (ed25519 or agent-key)");
	const mode = raw?.trim() ?? "ed25519";
	if (mode !== "ed25519" && mode !== "agent-key") throw new KitConfigError('COMMERTIZE_RECEIPT_SIGNER is "ed25519" (default) or "agent-key"');
	const home = seams.home ?? homedir();
	// Kill switch first, in both modes: nothing is read, signed or sent while it is on.
	ensureDefaultDisabled(home);
	assertNotDisabled(home);
	let log: ReceiptLog;
	if (mode === "agent-key") {
		// secp256k1 with the agent key from the OS keychain (CAS-1 5.1.1); key_id is the agent address.
		log = agentKeyReceiptLog({ mandateId: need("COMMERTIZE_MANDATE_ID"), agentId: need("COMMERTIZE_AGENT_ID") }, { keychain: seams.keychain ?? osKeychain(), home });
	} else {
		const keyId = need("COMMERTIZE_AGENT_KEY_ID");
		log = new ReceiptLog(
			{ mandateId: need("COMMERTIZE_MANDATE_ID"), agentId: need("COMMERTIZE_AGENT_ID"), agentKeyId: keyId },
			guardSigner(ed25519Signer(need("COMMERTIZE_AGENT_SEED"), keyId), home)
		);
	}
	const client = new KillSwitchClient(seams.client ?? new CommertizeClient(readEnv(env, allowHost)), home);
	const res = await template.run({ client, log, model });
	console.log(JSON.stringify(res, null, 2));
	process.exitCode = res.stopped.length ? 3 : 0;
	return res;
}
