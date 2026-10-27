// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { randomBytes } from "node:crypto";
import { CommertizeClient, ReceiptLog, ed25519Signer, ed25519PublicKey, type Fetch, type ModelSeam } from "../src/index.ts";

export interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/** A fetch that answers from a table keyed "METHOD /path" and records every call. */
export function fakeFetch(table: Record<string, { status?: number; body: unknown }>) {
	const calls: Call[] = [];
	const f: Fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push({ method, url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string });
		const hit = table[`${method} ${url.pathname}`];
		if (!hit) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
		return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
	};
	return { f, calls };
}

export function newKey() {
	const seed = randomBytes(32).toString("base64url");
	return { seed, pub: ed25519PublicKey(seed), keyId: "agent-key-1" };
}

export function ctxFor(fetchImpl: Fetch, env = { baseUrl: "https://api.example.test", sessionToken: "s-token", apiKey: "k-key" }) {
	const k = newKey();
	const log = new ReceiptLog({ mandateId: "m-1", agentId: "agent-1", agentKeyId: k.keyId }, ed25519Signer(k.seed, k.keyId));
	const prompts: unknown[] = [];
	const model: ModelSeam = async (p) => {
		prompts.push(p);
		return `stub answer for ${p.task}`;
	};
	return { client: new CommertizeClient(env, fetchImpl), log, model, key: k, prompts };
}
