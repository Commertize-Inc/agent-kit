// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `serve` (K-6a): the operator's own handler behind an x402 `exact` payment, on the operator's machine.
 *
 * Posture. Self-hosted only: Commertize runs no handler and binds no port for anyone. The payer pays
 * the operator directly (payTo is the operator's payee, fixed when the seller is built). Commertize is
 * never the facilitator, never holds funds and never holds a payment authorization: the payer's
 * signed authorization goes from this process to the operator's facilitator and nowhere else.
 *
 * Order of one call (each step refuses before the next one runs):
 *   1. kill files (~/.commertize/serve/DISABLED, then the kit signing kill file): no challenge at all
 *   2. input size and JSON
 *   3. no PAYMENT-SIGNATURE: 402 with PAYMENT-REQUIRED
 *   4. local payment checks, no facilitator call: shape, payTo, exact amount (BigInt), validity window,
 *      EIP-712 signature recovers to `from`, nonce not seen
 *   5. sanctions screen of the payer address (unavailable = refused)
 *   6. Tier 0 per-address caps (TIER0, base units): per call, per 24 h, per 30 days (reserved here)
 *   7. facilitator /verify, 8. handler, 9. facilitator /settle, 10. response (+ onSettled, e.g. a receipt)
 *
 * The x402 shapes mirror the Commertize backend module (apps/backend/src/agentCommerce/x402.ts on main,
 * read 2026-10-28): headers, MIN_REMAINING_VALIDITY_S, the exact-value rule, the no-slack
 * maxTimeoutSeconds rule and the settle refusals that mean nothing was broadcast.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "./keccak.ts";
import { recoverAddress } from "./secp256k1.ts";
import { assertNotDisabled, DisabledError, kitDirOf } from "./receiptsigner.ts";

/** ~/.commertize/serve/DISABLED: stops new challenges at once. */
export function serveKillFilePath(home: string): string {
	return join(kitDirOf(home), "serve", "DISABLED");
}

/**
 * Throws DisabledError when serving must stop: the serve kill file is present or unreadable, or kit
 * signing is not on (every settled call needs a signed receipt, and signing is off by default).
 */
export function assertServeEnabled(home: string): void {
	const p = serveKillFilePath(home);
	try {
		lstatSync(p);
		throw new DisabledError(p);
	} catch (e) {
		if (e instanceof DisabledError) throw e;
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new DisabledError(p, `could not be checked (${(e as NodeJS.ErrnoException).code ?? "error"})`);
	}
	assertNotDisabled(home);
}

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";
export const X402_VERSION = 2;
export const MIN_REMAINING_VALIDITY_S = 30;

export interface UsdcNetwork {
	network: string;
	chainId: number;
	asset: string;
	name: string;
	version: string;
}

/** The networks a seller may name. Only the test network is open; Base mainnet is defined and refused. */
export const USDC_NETWORKS: Readonly<Record<string, UsdcNetwork & { open: boolean }>> = Object.freeze({
	"eip155:84532": { network: "eip155:84532", chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2", open: true },
	"eip155:8453": { network: "eip155:8453", chainId: 8453, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", open: false },
});

/** Tier 0 seller caps, per payer address, in USDC base units (6 decimals). */
export const TIER0 = Object.freeze({
	perCall: 1_000_000n,
	per24h: 25_000_000n,
	per30d: 250_000_000n,
});
const DAY_MS = 86_400_000;

/** Settle failures that mean nothing was broadcast (backend SETTLE_REFUSALS_BEFORE_BROADCAST). Any other failure keeps the cap reservation. */
export const SETTLE_REFUSALS_BEFORE_BROADCAST: ReadonlySet<string> = new Set([
	"insufficient_funds",
	"invalid_exact_evm_payload_authorization_valid_after",
	"invalid_exact_evm_payload_authorization_valid_before",
	"invalid_exact_evm_payload_authorization_value_mismatch",
	"invalid_exact_evm_payload_signature",
	"invalid_exact_evm_payload_recipient_mismatch",
	"invalid_network",
	"invalid_payload",
	"invalid_payment_requirements",
	"invalid_scheme",
	"unsupported_scheme",
	"invalid_x402_version",
]);

export class ServeConfigError extends Error {
	constructor(m: string) {
		super(m);
		this.name = "ServeConfigError";
	}
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DIGITS = /^(0|[1-9][0-9]{0,30})$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** "0.05" -> 50000n. At most 6 decimals, no sign, no exponent, no float. */
export function usdcToBaseUnits(decimal: string): bigint {
	const m = typeof decimal === "string" ? /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,6}))?$/.exec(decimal) : null;
	if (!m) throw new ServeConfigError(`not a USDC amount with at most 6 decimals: ${String(decimal)}`);
	return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

// --- config -------------------------------------------------------------------------------------

export interface ServeConfig {
	schema: "commertize.serve/v1";
	serviceId: string;
	endpoint: { path: string; publicUrl: string; maxInputBytes: number };
	pricing: { currency: "USDC"; pricePerCall: string; network: string };
	/** Derived: the price in base units. */
	priceBase: bigint;
	usdc: UsdcNetwork;
	maxTimeoutSeconds: number;
}

const only = (o: Record<string, unknown>, keys: string[], where: string) => {
	for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ServeConfigError(`${where}: unknown key "${k}"`);
};
const obj = (v: unknown, where: string): Record<string, unknown> => {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new ServeConfigError(`${where} must be an object`);
	return v as Record<string, unknown>;
};

/**
 * Parses commertize.serve.json. Fails closed: an unknown key, a payee in the file (payTo comes from the
 * operator's mandate, never from a file), a price of zero, a price over the Tier 0 per-call cap, or a
 * network that is not open is refused.
 */
export function parseServeConfig(raw: unknown): ServeConfig {
	const c = obj(raw, "config");
	only(c, ["schema", "serviceId", "operator", "handler", "endpoint", "pricing", "limits", "description"], "config");
	if (c.schema !== "commertize.serve/v1") throw new ServeConfigError('config.schema must be "commertize.serve/v1"');
	const serviceId = c.serviceId ?? "";
	if (typeof serviceId !== "string" || (serviceId !== "" && !/^svc_[0-9A-Za-z]{1,64}$/.test(serviceId))) throw new ServeConfigError("config.serviceId must be empty or svc_<id>");
	const e = obj(c.endpoint, "config.endpoint");
	only(e, ["path", "publicUrl", "inputSchema", "outputSchema", "maxInputBytes", "maxOutputBytes"], "config.endpoint");
	if (typeof e.path !== "string" || !/^\/[A-Za-z0-9/_.-]{0,127}$/.test(e.path)) throw new ServeConfigError("config.endpoint.path must start with /");
	let url: URL;
	try {
		url = new URL(String(e.publicUrl));
	} catch {
		throw new ServeConfigError("config.endpoint.publicUrl must be an https URL");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new ServeConfigError("config.endpoint.publicUrl must be an https URL with no credentials, query or fragment");
	const maxInputBytes = e.maxInputBytes ?? 262_144;
	if (!Number.isSafeInteger(maxInputBytes) || (maxInputBytes as number) < 1 || (maxInputBytes as number) > 1_048_576) throw new ServeConfigError("config.endpoint.maxInputBytes must be 1..1048576");
	const p = obj(c.pricing, "config.pricing");
	only(p, ["currency", "pricePerCall", "network"], "config.pricing");
	if (p.currency !== "USDC") throw new ServeConfigError('config.pricing.currency must be "USDC"');
	const priceBase = usdcToBaseUnits(p.pricePerCall as string);
	if (priceBase <= 0n) throw new ServeConfigError("config.pricing.pricePerCall must be more than 0");
	if (priceBase > TIER0.perCall) throw new ServeConfigError("config.pricing.pricePerCall is over the Tier 0 per-call cap (1000000 base units)");
	const net = USDC_NETWORKS[p.network as string];
	if (!net || !Object.hasOwn(USDC_NETWORKS, p.network as string)) throw new ServeConfigError(`config.pricing.network must be one of: ${Object.keys(USDC_NETWORKS).join(", ")}`);
	if (!net.open) throw new ServeConfigError(`config.pricing.network ${net.network} is Not open in this release; use eip155:84532`);
	const { open: _open, ...usdc } = net;
	return {
		schema: "commertize.serve/v1",
		serviceId,
		endpoint: { path: e.path, publicUrl: url.origin, maxInputBytes: maxInputBytes as number },
		pricing: { currency: "USDC", pricePerCall: p.pricePerCall as string, network: net.network },
		priceBase,
		usdc,
		maxTimeoutSeconds: 300,
	};
}

// --- x402 payload -------------------------------------------------------------------------------

export interface PaymentRequirements {
	scheme: "exact";
	network: string;
	amount: string;
	asset: string;
	payTo: string;
	resource: string;
	maxTimeoutSeconds: number;
	extra: { name: string; version: string; serviceId: string };
}

export interface Authorization {
	from: string;
	to: string;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: string;
}

export interface PaymentPayload {
	x402Version: 2;
	accepted: { scheme: string; network: string; amount: string; asset: string; payTo: string };
	payload: { signature: string; authorization: Authorization };
}

/** Header -> payload, or null when it is not a well-formed v2 exact EVM payload. */
export function decodePaymentSignature(header: string | undefined): PaymentPayload | null {
	if (!header || header.length > 8192 || !/^[A-Za-z0-9+/=_-]+$/.test(header)) return null;
	let j: any;
	try {
		j = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
	} catch {
		return null;
	}
	if (!j || typeof j !== "object" || j.x402Version !== X402_VERSION) return null;
	const a = j.accepted;
	if (!a || typeof a !== "object" || typeof a.scheme !== "string" || typeof a.network !== "string" || typeof a.amount !== "string" || !DIGITS.test(a.amount) || typeof a.asset !== "string" || !ADDR.test(a.asset) || typeof a.payTo !== "string" || !ADDR.test(a.payTo)) return null;
	const p = j.payload;
	if (!p || typeof p !== "object" || Object.keys(p).length !== 2 || typeof p.signature !== "string" || !SIG.test(p.signature)) return null;
	const au = p.authorization;
	if (!au || typeof au !== "object") return null;
	const keys = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
	if (Object.keys(au).length !== keys.length || !keys.every((k) => Object.hasOwn(au, k) && typeof au[k] === "string")) return null;
	if (!ADDR.test(au.from) || !ADDR.test(au.to) || !DIGITS.test(au.value) || !DIGITS.test(au.validAfter) || !DIGITS.test(au.validBefore) || !NONCE.test(au.nonce)) return null;
	return {
		x402Version: 2,
		accepted: { scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo },
		payload: { signature: p.signature, authorization: { from: au.from, to: au.to, value: au.value, validAfter: au.validAfter, validBefore: au.validBefore, nonce: au.nonce } },
	};
}

export type MatchFailure = "scheme" | "network" | "asset" | "pay_to" | "amount" | "authorization_to" | "authorization_value" | "not_yet_valid" | "expiring" | "validity_too_long" | "bad_clock";

/** Local checks before any facilitator call: what would settle pays exactly this price to exactly this payee. */
export function matchRequirements(p: PaymentPayload, req: PaymentRequirements, nowSec: number): MatchFailure | null {
	const a = p.accepted;
	const auth = p.payload.authorization;
	if (a.scheme !== req.scheme) return "scheme";
	if (a.network !== req.network) return "network";
	if (!sameAddr(a.asset, req.asset)) return "asset";
	if (!sameAddr(a.payTo, req.payTo)) return "pay_to";
	if (BigInt(a.amount) !== BigInt(req.amount)) return "amount";
	if (!sameAddr(auth.to, req.payTo)) return "authorization_to";
	// exact scheme: the signed value is the price, never "at least" the price
	if (BigInt(auth.value) !== BigInt(req.amount)) return "authorization_value";
	if (!Number.isSafeInteger(nowSec)) return "bad_clock";
	const now = BigInt(nowSec);
	if (BigInt(auth.validAfter) > now) return "not_yet_valid";
	if (BigInt(auth.validBefore) < now + BigInt(MIN_REMAINING_VALIDITY_S)) return "expiring";
	if (BigInt(auth.validBefore) > now + BigInt(req.maxTimeoutSeconds)) return "validity_too_long";
	return null;
}

const enc = (s: string) => Buffer.from(s, "utf8");
const word = (n: bigint) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
const addrWord = (a: string) => Buffer.concat([Buffer.alloc(12), Buffer.from(a.slice(2), "hex")]);
const DOMAIN_TYPEHASH = keccak256(enc("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const TWA_TYPEHASH = keccak256(enc("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));

/** The EIP-712 digest of an EIP-3009 TransferWithAuthorization under the given USDC domain. */
export function domainSeparator(usdc: UsdcNetwork): Uint8Array {
	return keccak256(Buffer.concat([DOMAIN_TYPEHASH, keccak256(enc(usdc.name)), keccak256(enc(usdc.version)), word(BigInt(usdc.chainId)), addrWord(usdc.asset)]));
}

export function transferAuthorizationDigest(usdc: UsdcNetwork, a: Authorization): Uint8Array {
	const domain = domainSeparator(usdc);
	const struct = keccak256(
		Buffer.concat([TWA_TYPEHASH, addrWord(a.from), addrWord(a.to), word(BigInt(a.value)), word(BigInt(a.validAfter)), word(BigInt(a.validBefore)), Buffer.from(a.nonce.slice(2), "hex")])
	);
	return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domain, struct]));
}

/** True only when the signature recovers to authorization.from under OUR domain (never the payer's `accepted`). EOA only. */
export function signatureMatchesPayer(p: PaymentPayload, usdc: UsdcNetwork): boolean {
	try {
		const signer = recoverAddress(transferAuthorizationDigest(usdc, p.payload.authorization), Buffer.from(p.payload.signature.slice(2), "hex"));
		return sameAddr(signer, p.payload.authorization.from);
	} catch {
		return false;
	}
}

// --- Tier 0 caps --------------------------------------------------------------------------------

export interface CapEntry {
	payer: string;
	amount: bigint;
	atMs: number;
}

/** Spend per payer address. `reserve` is synchronous so two calls in flight cannot both fit under a cap. */
export class CapLedger {
	readonly #entries: CapEntry[] = [];
	readonly #persist: ((e: CapEntry) => void) | undefined;
	constructor(o: { entries?: CapEntry[]; persist?: (e: CapEntry) => void } = {}) {
		for (const e of o.entries ?? []) this.#entries.push({ ...e, payer: e.payer.toLowerCase() });
		this.#persist = o.persist;
	}
	/** Sum for one payer since `sinceMs` (inclusive). */
	spent(payer: string, sinceMs: number): bigint {
		const p = payer.toLowerCase();
		let s = 0n;
		for (const e of this.#entries) if (e.payer === p && e.atMs >= sinceMs) s += e.amount;
		return s;
	}
	/** Reserves `amount` for `payer`, or returns which cap it would pass. The returned release() undoes it. */
	reserve(payer: string, amount: bigint, nowMs: number): { ok: true; release: () => void } | { ok: false; cap: "per_call" | "per_24h" | "per_30d" } {
		if (amount > TIER0.perCall) return { ok: false, cap: "per_call" };
		if (this.spent(payer, nowMs - DAY_MS + 1) + amount > TIER0.per24h) return { ok: false, cap: "per_24h" };
		if (this.spent(payer, nowMs - 30 * DAY_MS + 1) + amount > TIER0.per30d) return { ok: false, cap: "per_30d" };
		const e: CapEntry = { payer: payer.toLowerCase(), amount, atMs: nowMs };
		// Persist first: if the write fails, nothing is reserved and the call is refused (fail closed).
		this.#persist?.(e);
		this.#entries.push(e);
		let released = false;
		return {
			ok: true,
			release: () => {
				if (released) return;
				released = true;
				// Write the release first. If it fails, the entry stays counted here and on disk (fail closed); never throws.
				try {
					this.#persist?.({ ...e, amount: -e.amount });
				} catch {
					return;
				}
				const i = this.#entries.indexOf(e);
				if (i >= 0) this.#entries.splice(i, 1);
			},
		};
	}
}

/**
 * The (payer, nonce) pairs this seller has accepted for checking. Persisted before it counts, so a
 * restart does not let an already-presented authorization reach the facilitator or the handler again.
 * Load `entries` from the same store the operator gives the CapLedger.
 */
export class NonceStore {
	readonly #seen = new Set<string>();
	readonly #persist: ((key: string) => void) | undefined;
	constructor(o: { entries?: string[]; persist?: (key: string) => void } = {}) {
		for (const k of o.entries ?? []) this.#seen.add(k.toLowerCase());
		this.#persist = o.persist;
	}
	has(key: string): boolean {
		return this.#seen.has(key.toLowerCase());
	}
	/** Throws when the write fails; then nothing is recorded and the caller refuses the call. */
	add(key: string): void {
		const k = key.toLowerCase();
		this.#persist?.(k);
		this.#seen.add(k);
	}
}

// --- the seller ---------------------------------------------------------------------------------

export type ScreenResult = "clear" | "listed" | "unavailable";

export interface Facilitator {
	verify(p: PaymentPayload, req: PaymentRequirements): Promise<{ isValid: boolean; invalidReason?: string }>;
	settle(p: PaymentPayload, req: PaymentRequirements): Promise<{ success: boolean; transaction?: string; errorReason?: string }>;
}

export interface SellerResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
	/** Why the call stopped (tests and the local audit log; never sent). */
	reason: string;
}

export interface SellerDeps {
	config: ServeConfig;
	/** The operator's payee, resolved from the operator's mandate. Never from the config file. */
	payTo: string;
	facilitator: Facilitator;
	/** Sanctions screen of a payer address. Anything but "clear" refuses the call. */
	screen: (address: string) => Promise<ScreenResult>;
	/** Throws when a kill file is present or unreadable. Checked first on every call. */
	assertEnabled: () => void;
	handler: (input: unknown) => Promise<unknown>;
	caps?: CapLedger;
	/** Accepted (payer, nonce) pairs. Give it a persisted store so a restart keeps them (in memory by default). */
	nonces?: NonceStore;
	now?: () => number;
	/** After settlement: e.g. issues the receipt. Its result goes in the response headers. */
	onSettled?: (s: { payer: string; amount: bigint; transaction: string; requestBody: Buffer; responseBody: string }) => Promise<Record<string, string>>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const err = (status: number, code: string, message: string, reason: string, retryable = false, headers: Record<string, string> = {}): SellerResponse => ({
	status,
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify({ error: { code, message, retryable } }),
	reason,
});

export class OperatorSeller {
	readonly #d: SellerDeps;
	readonly #req: PaymentRequirements;
	readonly #nonces: NonceStore;
	readonly #caps: CapLedger;
	constructor(d: SellerDeps) {
		if (typeof d.payTo !== "string" || !ADDR.test(d.payTo) || /^0x0{40}$/.test(d.payTo)) throw new ServeConfigError("payTo must be a non-zero 0x address from the operator's mandate");
		this.#d = d;
		this.#caps = d.caps ?? new CapLedger();
		this.#nonces = d.nonces ?? new NonceStore();
		const c = d.config;
		this.#req = {
			scheme: "exact",
			network: c.usdc.network,
			amount: c.priceBase.toString(),
			asset: c.usdc.asset,
			payTo: d.payTo,
			resource: c.endpoint.publicUrl + c.endpoint.path,
			maxTimeoutSeconds: c.maxTimeoutSeconds,
			extra: { name: c.usdc.name, version: c.usdc.version, serviceId: c.serviceId },
		};
	}

	get requirements(): PaymentRequirements {
		return { ...this.#req, extra: { ...this.#req.extra } };
	}

	async handle(headers: Record<string, string | undefined>, body: Buffer): Promise<SellerResponse> {
		const d = this.#d;
		try {
			d.assertEnabled();
		} catch (e) {
			return err(503, "SERVE_DISABLED", (e as Error).message, "disabled");
		}
		if (body.length > d.config.endpoint.maxInputBytes) return err(400, "INPUT_TOO_LARGE", "the request body is over maxInputBytes", "input_too_large");
		let input: unknown;
		try {
			input = JSON.parse(body.toString("utf8"));
		} catch {
			return err(400, "INPUT_SCHEMA", "the request body is not JSON", "input_schema");
		}
		const sigHeader = headers[HEADER_SIGNATURE.toLowerCase()];
		if (sigHeader === undefined) {
			return {
				status: 402,
				headers: { "content-type": "application/json", [HEADER_REQUIRED]: b64({ x402Version: X402_VERSION, error: "payment required", resource: { url: this.#req.resource }, accepts: [this.requirements] }) },
				body: "{}",
				reason: "challenge",
			};
		}
		const p = decodePaymentSignature(sigHeader);
		if (!p) return err(422, "PAYMENT_INVALID", "PAYMENT-SIGNATURE is not a well-formed x402 v2 exact payload", "malformed");
		const nowMs = (d.now ?? Date.now)();
		const m = matchRequirements(p, this.#req, Math.floor(nowMs / 1000));
		if (m === "pay_to" || m === "authorization_to") return err(422, "PAYEE_MISMATCH", "the payment names a different payee", m);
		if (m === "amount" || m === "authorization_value") return err(422, "AMOUNT_MISMATCH", "the payment amount is not the price", m);
		if (m) return err(422, "PAYMENT_INVALID", `payment refused: ${m}`, m);
		if (!signatureMatchesPayer(p, d.config.usdc)) return err(422, "PAYMENT_INVALID", "the signature does not recover to the payer", "signature");
		const auth = p.payload.authorization;
		const nonceKey = `${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
		if (this.#nonces.has(nonceKey)) return err(422, "PAYMENT_INVALID", "this authorization was already presented", "nonce_replay");
		try {
			this.#nonces.add(nonceKey);
		} catch {
			return err(503, "NONCE_STORE_UNAVAILABLE", "the local nonce store could not be written; nothing was charged", "nonce_store");
		}
		let screened: ScreenResult;
		try {
			screened = await d.screen(auth.from);
		} catch {
			screened = "unavailable";
		}
		if (screened === "listed") return err(403, "PAYER_REFUSED", "this payer cannot be served", "screen_listed");
		if (screened !== "clear") return err(503, "SCREEN_UNAVAILABLE", "the payer screen did not run; nothing was charged", "screen_unavailable", true);
		const amount = BigInt(auth.value);
		let r: ReturnType<CapLedger["reserve"]>;
		try {
			r = this.#caps.reserve(auth.from, amount, nowMs);
		} catch {
			return err(503, "CAP_LEDGER_UNAVAILABLE", "the local cap ledger could not be written; nothing was charged", "cap_ledger");
		}
		if (!r.ok) return err(429, "TIER0_CAP", `Tier 0 cap reached for this payer (${r.cap})`, `cap_${r.cap}`);
		const release = r.release;
		try {
			const v = await d.facilitator.verify(p, this.requirements);
			if (!v || v.isValid !== true) {
				release();
				return err(422, "PAYMENT_INVALID", "the facilitator did not verify the payment", "verify_failed");
			}
		} catch {
			release();
			return err(503, "FACILITATOR_UNAVAILABLE", "the facilitator could not verify the payment; nothing was charged", "verify_error", true);
		}
		let output: string;
		try {
			const out = await d.handler(input);
			output = JSON.stringify(out ?? null);
		} catch {
			release();
			return err(502, "HANDLER_FAILED", "the handler failed; the payment was not settled", "handler_failed");
		}
		let s: Awaited<ReturnType<Facilitator["settle"]>>;
		try {
			s = await d.facilitator.settle(p, this.requirements);
		} catch {
			s = { success: false, errorReason: "settle_error" };
		}
		if (!s || s.success !== true || typeof s.transaction !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(s.transaction)) {
			// Only a refusal that means nothing was broadcast gives the cap back.
			if (s && typeof s.errorReason === "string" && SETTLE_REFUSALS_BEFORE_BROADCAST.has(s.errorReason)) release();
			return err(502, "SETTLE_FAILED", "the payment did not settle; the result was discarded", "settle_failed");
		}
		const paymentResponse = b64({ success: true, transaction: s.transaction, network: this.#req.network, payer: auth.from });
		let extra: Record<string, string> = {};
		if (d.onSettled) {
			try {
				extra = await d.onSettled({ payer: auth.from, amount, transaction: s.transaction, requestBody: body, responseBody: output });
			} catch {
				// Money moved. The result is sent; the missing receipt is visible in the header.
				extra = { "X-Commertize-Receipt": "none" };
			}
		}
		return { status: 200, headers: { "content-type": "application/json", [HEADER_RESPONSE]: paymentResponse, ...extra }, body: output, reason: "settled" };
	}
}
