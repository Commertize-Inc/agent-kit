// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
//
// DRAFT, NOT FOR RELEASE. Read-only client for the Commertize marketplace
// API (path: MARKET_API_PATH). No runtime dependencies, no environment reads, no
// telemetry: every setting is an argument.

export const VERSION = "0.1.0";
/** The API host. commertize.com (the site) serves no /api route. */
export const DEFAULT_ORIGIN = "https://api.commertize.com";
/**
 * The one place this package names the marketplace API path. Every URL the
 * client builds starts from it; bin/install.mjs carries the same value and a
 * test pins the two together. The served path is not settled yet: change it
 * here (and there) only.
 */
export const MARKET_API_PATH = "/api/market/v1";
export const DEFAULT_BASE_URL = DEFAULT_ORIGIN + MARKET_API_PATH;

export type Network = "base" | "base-sepolia";
export const NETWORKS: readonly Network[] = ["base", "base-sepolia"];
export const CHAIN_IDS: Readonly<Record<Network, number>> = { base: 8453, "base-sepolia": 84532 };
/** Base Sepolia (chain id 84532). Base mainnet is used only with allowMainnet: true. */
export const DEFAULT_NETWORK: Network = "base-sepolia";
export const MAINNET: Network = "base";

/** Testnet always; mainnet only when allowMainnet is exactly true. */
export function networkAllowed(network: Network, allowMainnet: unknown): boolean {
	return network !== MAINNET || allowMainnet === true;
}

export type EntryState = "claimed" | "unclaimed";
export type ListingCheckStatus = "passed" | "failed" | "pending" | "stale" | "not_applicable";

export interface ListingChecks {
	status: ListingCheckStatus;
	last_checked_at: string | null;
	checks_passed?: string[];
	checks_failed?: string[];
	observed_402_matches_listing?: boolean;
	scope?: string;
}

export interface Price {
	amount: string;
	amount_atomic: string;
	asset_symbol: string;
	asset_address: string;
	decimals: number;
}

export interface EndpointSummary {
	endpoint_id: string;
	method: string;
	url: string;
	use_when?: string;
	price?: Partial<Price>;
}

export interface Service {
	service_id: string;
	name: string;
	domain: string;
	use_when?: string;
	description?: string;
	category?: string;
	network: Network;
	network_label?: string;
	entry_state: EntryState;
	listing_source?: string;
	disclaimer?: string | null;
	listing_checks: ListingChecks;
	payment_request_seen?: Record<string, unknown>;
	receipts?: { supported: boolean; receipt_url_template?: string };
	price_from?: { amount: string; asset_symbol: string; unit: string };
	endpoint_count?: number;
	endpoints?: EndpointSummary[];
	listed_at?: string;
	detail_url?: string;
	/** Set by this client on Base Sepolia results. */
	testnet?: true;
}

export interface Endpoint {
	endpoint_id: string;
	service_id: string;
	method: "GET" | "POST";
	url: string;
	use_when?: string;
	description?: string;
	price: Price;
	network: Network;
	chain_id: number;
	pay_to: string;
	x402?: { version: number; scheme: string };
	input_schema?: unknown;
	output_schema?: unknown;
	example?: unknown;
	listing_checks?: ListingChecks;
	receipts?: { supported: boolean };
	testnet?: true;
}

/**
 * Payment check result, AEGIS design D (interface only: nothing in this
 * package produces it yet). Without a Commertize receipt envelope the only
 * true statement is TRANSFER_ONLY_LABEL (AXIOM bytes, 2026-11-18): the
 * transfer happened, not which request it paid for. The envelope-bound form
 * is added only when the envelope, the published keys and the receipts
 * route are served.
 */
export const TRANSFER_ONLY_LABEL = "transfer found on-chain, no receipt binding";
export interface TransferOnlyCheck {
	binding: "none";
	label: typeof TRANSFER_ONLY_LABEL;
	network: Network;
	tx_hash: string;
	payee: string;
	/** Smallest unit of the asset, integer string. */
	amount_atomic: string;
}
export type PaymentCheck = TransferOnlyCheck;

export interface SearchOptions {
	q?: string;
	/** One category; the API refuses a repeated parameter. */
	category?: string;
	/** Defaults to "base-sepolia" (DEFAULT_NETWORK). "base" (mainnet) is refused unless the client has allowMainnet: true. */
	network?: Network;
	maxPriceUsd?: string | number;
	checksPassed?: boolean;
	sort?: "newest" | "price_asc" | "last_checked_desc";
	limit?: number;
	cursor?: string;
}

export interface SearchResult {
	results: Service[];
	next_cursor: string | null;
	total_estimate?: number;
	network: Network;
	/** Count of rows the client dropped because their network differed from the one asked for. */
	dropped_other_network: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
	/** Defaults to DEFAULT_BASE_URL. Must be https (plain http only for localhost). */
	baseUrl?: string;
	/** Defaults to the global fetch. */
	fetch?: FetchLike;
	/** Must be exactly true before any call may name Base mainnet ("base"). Default false. */
	allowMainnet?: boolean;
}

export class MarketConfigError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "MarketConfigError";
	}
}

export class MarketApiError extends Error {
	status: number;
	code: string;
	param?: string;
	constructor(status: number, code: string, message: string, param?: string) {
		super(message);
		this.name = "MarketApiError";
		this.status = status;
		this.code = code;
		if (param !== undefined) this.param = param;
	}
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DECIMAL_RE = /^\d{1,12}(\.\d{1,18})?$/;

export function normaliseBaseUrl(raw: string): string {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		throw new MarketConfigError("baseUrl is not a URL");
	}
	if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname)))
		throw new MarketConfigError("baseUrl must be https (http only for localhost)");
	if (u.username || u.password || u.search || u.hash)
		throw new MarketConfigError("baseUrl must not carry credentials, a query or a fragment");
	return u.toString().replace(/\/+$/, "");
}

export function isNetwork(v: unknown): v is Network {
	return typeof v === "string" && (NETWORKS as readonly string[]).includes(v);
}

function checkId(kind: string, id: unknown): string {
	if (typeof id !== "string" || !ID_RE.test(id)) throw new MarketConfigError(`${kind} must match ${ID_RE}`);
	return id;
}

/** Parses a non-negative integer string or bigint; never accepts a float. */
export function toAtomic(v: unknown): bigint | null {
	if (typeof v === "bigint") return v >= 0n ? v : null;
	if (typeof v === "string" && /^\d{1,78}$/.test(v)) return BigInt(v);
	return null;
}

export class MarketClient {
	readonly baseUrl: string;
	readonly allowMainnet: boolean;
	private readonly fetchImpl: FetchLike;

	constructor(opts: ClientOptions = {}) {
		this.baseUrl = normaliseBaseUrl(opts.baseUrl ?? DEFAULT_BASE_URL);
		const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
		if (typeof f !== "function") throw new MarketConfigError("no fetch available; pass options.fetch");
		this.fetchImpl = f;
		this.allowMainnet = opts.allowMainnet === true;
	}

	private async get(path: string): Promise<unknown> {
		const res = await this.fetchImpl(this.baseUrl + path, {
			method: "GET",
			redirect: "error",
			headers: { accept: "application/json", "user-agent": `commertize-market/${VERSION}` },
		});
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		if (!res.ok) {
			const e = (body as { error?: { code?: unknown; message?: unknown; param?: unknown } } | null)?.error;
			throw new MarketApiError(
				res.status,
				typeof e?.code === "string" ? e.code : "http_error",
				typeof e?.message === "string" ? e.message : `HTTP ${res.status}`,
				typeof e?.param === "string" ? e.param : undefined
			);
		}
		if (body === null || typeof body !== "object") throw new MarketApiError(res.status, "bad_response", "response is not a JSON object");
		return body;
	}

	async search(opts: SearchOptions = {}): Promise<SearchResult> {
		const network = opts.network ?? DEFAULT_NETWORK;
		if (!isNetwork(network)) throw new MarketConfigError('network must be "base" or "base-sepolia"');
		if (!networkAllowed(network, this.allowMainnet)) throw new MarketConfigError("Base mainnet is refused unless the client is created with allowMainnet: true");
		const p = new URLSearchParams();
		if (opts.q !== undefined) p.set("q", String(opts.q));
		// Only parameters the API accepts, each at most once: it answers 400 to
		// an unknown or repeated one (AEGIS M-1).
		if (opts.category !== undefined) {
			if (typeof opts.category !== "string") throw new MarketConfigError("category must be one string");
			p.set("category", opts.category);
		}
		p.set("network", network);
		if (opts.maxPriceUsd !== undefined) {
			const s = String(opts.maxPriceUsd);
			if (!DECIMAL_RE.test(s)) throw new MarketConfigError("maxPriceUsd must be a non-negative decimal");
			p.set("max_price_usd", s);
		}
		if (opts.checksPassed) p.set("checks_passed", "true");
		if (opts.sort !== undefined) {
			if (!["newest", "price_asc", "last_checked_desc"].includes(opts.sort)) throw new MarketConfigError("sort is not valid");
			p.set("sort", opts.sort);
		}
		if (opts.limit !== undefined) {
			if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 50) throw new MarketConfigError("limit must be an integer 1-50");
			p.set("limit", String(opts.limit));
		}
		if (opts.cursor !== undefined) p.set("cursor", opts.cursor);
		const body = (await this.get(`/services?${p.toString()}`)) as { results?: unknown; next_cursor?: unknown; total_estimate?: unknown };
		if (!Array.isArray(body.results)) throw new MarketApiError(200, "bad_response", "results is not an array");
		// Never mix networks, whatever the server sends.
		const kept = (body.results as Service[]).filter((s) => s && s.network === network);
		const results = network === "base-sepolia" ? kept.map((s) => ({ ...s, testnet: true as const })) : kept;
		const out: SearchResult = {
			results,
			next_cursor: typeof body.next_cursor === "string" ? body.next_cursor : null,
			network,
			dropped_other_network: body.results.length - kept.length,
		};
		if (typeof body.total_estimate === "number") out.total_estimate = body.total_estimate;
		return out;
	}

	async getService(serviceId: string): Promise<Service> {
		const s = (await this.get(`/services/${encodeURIComponent(checkId("serviceId", serviceId))}`)) as Service;
		if (s.service_id !== serviceId) throw new MarketApiError(200, "bad_response", "service_id differs from the one asked for");
		return s.network === "base-sepolia" ? { ...s, testnet: true } : s;
	}

	async getEndpoint(endpointId: string): Promise<Endpoint> {
		const e = (await this.get(`/endpoints/${encodeURIComponent(checkId("endpointId", endpointId))}`)) as Endpoint;
		if (e.endpoint_id !== endpointId) throw new MarketApiError(200, "bad_response", "endpoint_id differs from the one asked for");
		return e.network === "base-sepolia" ? { ...e, testnet: true } : e;
	}
}

export function createMarketClient(opts: ClientOptions = {}): MarketClient {
	return new MarketClient(opts);
}

// snake_case aliases matching the API / tool names.
export const search = (opts?: SearchOptions, client: ClientOptions = {}) => createMarketClient(client).search(opts);
export const get_service = (id: string, client: ClientOptions = {}) => createMarketClient(client).getService(id);
export const get_endpoint = (id: string, client: ClientOptions = {}) => createMarketClient(client).getEndpoint(id);