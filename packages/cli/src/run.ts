// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { CommertizeClient, KitConfigError, readEnv } from "./client.ts";
import { ReceiptLog, ed25519Signer } from "./cas.ts";
import type { ModelSeam, Template, TemplateResult } from "./kit.ts";

/**
 * Runs a template once on your machine, with ids and your signing seed read
 * from your environment. Prints the result; writes nothing to disk.
 *
 *  COMMERTIZE_MANDATE_ID, COMMERTIZE_AGENT_ID, COMMERTIZE_AGENT_KEY_ID  your own CAS ids
 *  COMMERTIZE_AGENT_SEED  raw 32-byte ed25519 seed, base64url (or pass your own Signer via runTemplate)
 *
 * Exit code: 0 done, 3 done but a step stopped on a route that is Not open.
 */
export async function runOnce(
	template: Template,
	model: ModelSeam,
	env: Record<string, string | undefined> = process.env,
	// One non-default API host you name in code; never read from the environment.
	allowHost?: string
): Promise<TemplateResult> {
	const need = (k: string): string => {
		const v = env[k]?.trim();
		if (!v) throw new KitConfigError(`${k} is not set`);
		return v;
	};
	const keyId = need("COMMERTIZE_AGENT_KEY_ID");
	const log = new ReceiptLog(
		{ mandateId: need("COMMERTIZE_MANDATE_ID"), agentId: need("COMMERTIZE_AGENT_ID"), agentKeyId: keyId },
		ed25519Signer(need("COMMERTIZE_AGENT_SEED"), keyId)
	);
	const res = await template.run({ client: new CommertizeClient(readEnv(env, allowHost)), log, model });
	console.log(JSON.stringify(res, null, 2));
	process.exitCode = res.stopped.length ? 3 : 0;
	return res;
}
