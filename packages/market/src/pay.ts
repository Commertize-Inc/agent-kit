// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
//
// DRAFT, NOT FOR RELEASE. Optional pay helper. It signs with the caller's own
// wallet object, only within a spending limit the caller sets, and only when
// the endpoint's live payment request equals the marketplace entry. The
// x402 client (peer dependency "x402", exact version in package.json) is
// loaded only when a payment is actually signed.

import { CHAIN_IDS, DEFAULT_NETWORK, VERSION, isNetwork, networkAllowed, toAtomic, type Endpoint, type FetchLike, type Network } from "./index.ts";

export class PayRefusedError extends Error {
	reason: string;
	constructor(reason: string, msg: string) {
		super(msg);
		this.name = "PayRefusedError";
		this.reason = reason;
	}
}

/** One x402 v1 `accepts` entry, as served in a live 402 body. */
export interface PaymentRequirements {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	resource?: string;
	description?: string;
	mimeType?: string;
	payTo: string;
	maxTimeoutSeconds?: number;
	asset: string;
	extra?: Record<string, unknown>;
	[k: string]: unknown;
}

export type CreatePaymentHeader = (wallet: object, x402Version: number, req: PaymentRequirements) => Promise<string>;

export interface SpendingLimitInit {
	network: Network;
	/** Asset contract address the limit is counted in (e.g. USDC on that network). */
	asset: string;
	/** Most one call may cost, in the asset's smallest unit (integer string or bigint). */
	perCall: string | bigint;
	/** Most all calls under this limit may cost together, same unit. */
	total: string | bigint;
}

export interface SpendingLimit {
	readonly network: Network;
	readonly asset: string;
	readonly perCall: bigint;
	readonly total: bigint;
	/** Amount already committed to signed payments under this limit. */
	readonly spent: bigint;
}

const LIMIT = Symbol("commertize.market.limit");
interface LimitState extends SpendingLimit {
	[LIMIT]: true;
	spent: bigint;
}

export function createSpendingLimit(init: SpendingLimitInit): SpendingLimit {
	if (!init || typeof init !== "object") throw new PayRefusedError("limit_invalid", "a spending limit object is required");
	if (!isNetwork(init.network)) throw new PayRefusedError("limit_invalid", 'limit.network must be "base" or "base-sepolia"');
	if (typeof init.asset !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(init.asset)) throw new PayRefusedError("limit_invalid", "limit.asset must be an address");
	const perCall = toAtomic(init.perCall);
	const total = toAtomic(init.total);
	if (perCall === null || total === null) throw new PayRefusedError("limit_invalid", "limit amounts must be integer strings or bigints in the asset's smallest unit");
	if (perCall === 0n || total === 0n || perCall > total) throw new PayRefusedError("limit_invalid", "limit amounts must be above zero and perCall must not exceed total");
	const s: LimitState = { [LIMIT]: true, network: init.network, asset: init.asset.toLowerCase(), perCall, total, spent: 0n };
	return s;
}

function isLimit(v: unknown): v is LimitState {
	return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[LIMIT] === true;
}

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;
const WORDS = /^[a-z]+( [a-z]+){11,23}$/;
const SECRET_NAMES = /^(private_?key|secret_?key|mnemonic|seed(_?phrase)?|phrase|keystore(_?path)?)$/i;

function looksSecret(v: unknown): boolean {
	if (typeof v === "string") {
		const t = v.trim();
		return HEX_KEY.test(t) || WORDS.test(t.toLowerCase().replace(/\s+/g, " "));
	}
	return v instanceof Uint8Array || v instanceof ArrayBuffer;
}

/** Refuses raw keys, seed phrases and objects that carry one. Exported for tests and callers. */
export function assertWalletObject(wallet: unknown): asserts wallet is object {
	if (wallet === null || wallet === undefined) throw new PayRefusedError("wallet_missing", "pass your own wallet or signer object");
	if (typeof wallet !== "object" && typeof wallet !== "function") throw new PayRefusedError("wallet_raw_secret", "pass a wallet or signer object, never a key or seed string");
	if (looksSecret(wallet)) throw new PayRefusedError("wallet_raw_secret", "pass a wallet or signer object, never raw key bytes");
	const scan = (o: object, depth: number): void => {
		for (const [k, v] of Object.entries(o)) {
			if (SECRET_NAMES.test(k) || looksSecret(v)) throw new PayRefusedError("wallet_raw_secret", `wallet object carries a key or seed in "${k}"; pass a signer that keeps its key private`);
			if (depth > 0 && v && typeof v === "object" && !Array.isArray(v)) scan(v, depth - 1);
		}
	};
	scan(wallet as object, 1);
}

export interface PayOptions {
	/** The entry from getEndpoint(); its url, pay_to, asset, network and amount are what the live request must equal. */
	endpoint: Endpoint;
	/** Your own wallet or signer object (e.g. a viem account or wallet client). Never a key or seed. */
	wallet: object;
	/** Required. Create with createSpendingLimit(); reuse it across calls to cap the total. */
	limit: SpendingLimit;
	/** Defaults to "base-sepolia" (DEFAULT_NETWORK). "base" (mainnet, real funds) is refused unless allowMainnet is exactly true. */
	network?: Network;
	/** Must be exactly true to pay on Base mainnet. Default false. */
	allowMainnet?: boolean;
	/** Request body for POST endpoints. */
	body?: string;
	headers?: Record<string, string>;
	fetch?: FetchLike;
	/** Override the x402 signer (defaults to createPaymentHeader from the "x402" peer). */
	createPaymentHeader?: CreatePaymentHeader;
}

export interface PayResult {
	paid: boolean;
	response: Response;
	amountAtomic?: bigint;
	payTo?: string;
	/** Present only if the endpoint's response named one. Header name provisional. */
	receiptId?: string;
}

async function defaultCreatePaymentHeader(wallet: object, x402Version: number, req: PaymentRequirements): Promise<string> {
	const spec = "x402/client";
	let mod: { createPaymentHeader?: (w: unknown, v: number, r: unknown) => Promise<string> };
	try {
		mod = await import(spec);
	} catch {
		throw new PayRefusedError("x402_missing", 'install the peer dependency "x402" to sign payments');
	}
	if (typeof mod.createPaymentHeader !== "function") throw new PayRefusedError("x402_missing", "x402/client has no createPaymentHeader");
	return mod.createPaymentHeader(wallet, x402Version, req);
}

function sameUrl(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		return x.origin === y.origin && x.pathname === y.pathname;
	} catch {
		return false;
	}
}

export async function payEndpoint(opts: PayOptions): Promise<PayResult> {
	// Every check below runs before any request is made.
	if (!opts || typeof opts !== "object") throw new PayRefusedError("options_missing", "options are required");
	const limit = opts.limit;
	if (!isLimit(limit)) throw new PayRefusedError("limit_missing", "a spending limit from createSpendingLimit() is required");
	assertWalletObject(opts.wallet);
	const network = opts.network ?? DEFAULT_NETWORK;
	if (!isNetwork(network)) throw new PayRefusedError("network_invalid", 'network must be "base" or "base-sepolia"');
	if (!networkAllowed(network, opts.allowMainnet)) throw new PayRefusedError("mainnet_not_allowed", "Base mainnet payments are refused unless allowMainnet: true is set");
	const ep = opts.endpoint;
	if (!ep || typeof ep !== "object") throw new PayRefusedError("endpoint_missing", "pass the entry from getEndpoint()");
	if (ep.network !== network || ep.chain_id !== CHAIN_IDS[network])
		throw new PayRefusedError("network_mismatch", `entry is on ${String(ep.network)}; this call allows ${network} only`);
	if (limit.network !== network) throw new PayRefusedError("limit_network", "the spending limit is for a different network");
	const entryAmount = toAtomic(ep.price?.amount_atomic);
	if (entryAmount === null || typeof ep.pay_to !== "string" || typeof ep.price?.asset_address !== "string")
		throw new PayRefusedError("entry_incomplete", "entry lacks pay_to, asset_address or amount_atomic");
	if (ep.price.asset_address.toLowerCase() !== limit.asset) throw new PayRefusedError("limit_asset", "the spending limit is for a different asset");
	let target: URL;
	try {
		target = new URL(ep.url);
	} catch {
		throw new PayRefusedError("endpoint_url", "entry url is not a URL");
	}
	if (target.protocol !== "https:") throw new PayRefusedError("endpoint_url", "entry url must be https");
	const method = ep.method === "POST" ? "POST" : "GET";
	const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
	if (typeof f !== "function") throw new PayRefusedError("fetch_missing", "no fetch available");
	const baseHeaders: Record<string, string> = { ...(opts.headers ?? {}), "user-agent": `commertize-market/${VERSION}` };
	const init = (extra: Record<string, string>): RequestInit => {
		const r: RequestInit = { method, redirect: "manual", headers: { ...baseHeaders, ...extra } };
		if (method === "POST" && opts.body !== undefined) r.body = opts.body;
		return r;
	};

	// 1. Unpaid request: read the endpoint's own live payment request.
	const first = await f(target.toString(), init({}));
	if (first.status !== 402) return { paid: false, response: first };
	let live: { x402Version?: unknown; accepts?: unknown };
	try {
		live = (await first.json()) as typeof live;
	} catch {
		throw new PayRefusedError("live_unreadable", "the 402 body is not JSON");
	}
	if (live?.x402Version !== 1) throw new PayRefusedError("live_version", "only x402 version 1 payment requests are supported");
	if (!Array.isArray(live.accepts) || live.accepts.length === 0) throw new PayRefusedError("live_unreadable", "the 402 lists no payment options");

	// 2. A 402 offering nothing on the configured network is refused outright.
	if (!(live.accepts as PaymentRequirements[]).some((a) => a && a.network === network))
		throw new PayRefusedError("live_network", `the live payment request names no option on ${network}; not paying`);

	// 3. Pay only an option that equals the entry on payee, asset, network and amount.
	const req = (live.accepts as PaymentRequirements[]).find(
		(a) =>
			a &&
			a.scheme === "exact" &&
			a.network === network &&
			typeof a.payTo === "string" &&
			a.payTo.toLowerCase() === ep.pay_to.toLowerCase() &&
			typeof a.asset === "string" &&
			a.asset.toLowerCase() === ep.price.asset_address.toLowerCase() &&
			toAtomic(a.maxAmountRequired) === entryAmount &&
			(a.resource === undefined || sameUrl(a.resource, target.toString()))
	);
	if (!req) throw new PayRefusedError("live_mismatch", "the live payment request differs from the entry (payee, asset, network, amount or resource); not paying");

	// 4. Spending limit, counted before signing (a failed retry still counts).
	if (entryAmount > limit.perCall) throw new PayRefusedError("over_per_call", "amount is above the per-call limit");
	if (limit.spent + entryAmount > limit.total) throw new PayRefusedError("over_total", "amount would exceed the total limit");
	limit.spent += entryAmount;

	// 5. Sign with the caller's wallet and retry once.
	const sign = opts.createPaymentHeader ?? defaultCreatePaymentHeader;
	const header = await sign(opts.wallet, 1, req);
	const paid = await f(target.toString(), init({ "x-payment": header }));
	const out: PayResult = { paid: true, response: paid, amountAtomic: entryAmount, payTo: req.payTo };
	const rid = paid.headers.get("x-commertize-receipt-id");
	if (rid && /^[A-Za-z0-9_-]{1,128}$/.test(rid)) out.receiptId = rid;
	return out;
}
