// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Read-only balances on Base, over the public JSON-RPC endpoints below.
 * Nothing here signs or sends a transaction.
 *
 * - The network table is fixed: no flag or environment variable can point
 *   the kit at another RPC host or another token contract.
 * - Every read first checks eth_chainId against the table; a mismatch stops
 *   the command (fail closed) before any balance is reported.
 * - Amounts stay integers (BigInt) end to end. `formatted` is built by
 *   integer division and remainder, never through a float.
 */

import { UnexpectedAnswerError } from "./whoami.ts";

export const NETWORKS = {
	base: { chainId: 8453, rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
	"base-sepolia": { chainId: 84532, rpc: "https://sepolia.base.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
} as const;
export type Network = keyof typeof NETWORKS;
export const TOKENS = ["USDC", "ETH"] as const;
export type Token = (typeof TOKENS)[number];
const DECIMALS: Record<Token, number> = { USDC: 6, ETH: 18 };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QTY = /^0x[0-9a-fA-F]{1,64}$/;
const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;
export const RPC_TIMEOUT_MS = 15_000;

export function isNetwork(s: string): s is Network {
	return Object.hasOwn(NETWORKS, s);
}

/** Integer base units to a decimal string, e.g. 1234567n with 6 decimals -> "1.234567". */
export function formatUnits(raw: bigint, decimals: number): string {
	if (raw < 0n) throw new Error("negative amount");
	const base = 10n ** BigInt(decimals);
	const whole = raw / base;
	const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
	return frac ? `${whole}.${frac}` : `${whole}`;
}

async function rpc(fetchImpl: typeof fetch, url: string, method: string, params: unknown[]): Promise<string> {
	const res = await fetchImpl(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		redirect: "error",
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	if (!res.ok) throw new UnexpectedAnswerError(`${method} answered HTTP ${res.status}`);
	let body: { result?: unknown; error?: unknown };
	try {
		body = (await res.json()) as typeof body;
	} catch {
		throw new UnexpectedAnswerError(`${method} answered something that is not JSON`);
	}
	if (body?.error !== undefined || typeof body?.result !== "string") throw new UnexpectedAnswerError(`${method} answered an error or no result`);
	return body.result;
}

export interface BalanceResult {
	network: Network;
	chainId: number;
	address: string;
	token: Token;
	contract: string | null;
	raw: string;
	decimals: number;
	formatted: string;
}

export async function balance(o: { network: Network; token: Token; address: string; fetch?: typeof fetch }): Promise<BalanceResult> {
	if (!ADDRESS.test(o.address)) throw new Error("address must be 0x and 40 hex characters");
	const net = NETWORKS[o.network];
	const f = o.fetch ?? fetch;
	const cid = await rpc(f, net.rpc, "eth_chainId", []);
	if (!HEX_QTY.test(cid) || BigInt(cid) !== BigInt(net.chainId))
		throw new UnexpectedAnswerError(`${net.rpc} is not chain ${net.chainId} (answered ${HEX_QTY.test(cid) ? BigInt(cid).toString() : "a non-number"}); refusing`);
	let rawHex: string;
	if (o.token === "ETH") {
		rawHex = await rpc(f, net.rpc, "eth_getBalance", [o.address, "latest"]);
		if (!HEX_QTY.test(rawHex)) throw new UnexpectedAnswerError("eth_getBalance answered a value that is not a quantity");
	} else {
		// balanceOf(address): selector 0x70a08231 + the address left-padded to 32 bytes
		const data = "0x70a08231" + o.address.slice(2).toLowerCase().padStart(64, "0");
		rawHex = await rpc(f, net.rpc, "eth_call", [{ to: net.usdc, data }, "latest"]);
		if (!HEX_WORD.test(rawHex)) throw new UnexpectedAnswerError("balanceOf answered a value that is not one 32-byte word");
	}
	const raw = BigInt(rawHex);
	const decimals = DECIMALS[o.token];
	return {
		network: o.network,
		chainId: net.chainId,
		address: o.address,
		token: o.token,
		contract: o.token === "USDC" ? net.usdc : null,
		raw: raw.toString(),
		decimals,
		formatted: formatUnits(raw, decimals),
	};
}
