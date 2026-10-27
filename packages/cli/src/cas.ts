// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * CAS v0.1 receipts for kit templates: build, hash (C-1), sign (C-2),
 * validate (receipt schema + R-1, R-2) and chain (R-3).
 *
 * The validator mirrors spec/cas/schemas/receipt.schema.json from
 * Commertize-Inc/commertize-agents by hand so the kit has no dependencies.
 * The conformance test checks that this hand validator refuses each rule's
 * negative case, so a drift shows up as a failing test.
 *
 * The public CAS specification and conformance vectors live at
 * https://github.com/Commertize-Inc/cas-spec (draft).
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalize } from "./canonical.ts";

export const CAS_VERSION = "0.1" as const;
export const ZERO_HASH = `sha256:${"0".repeat(64)}`;
export const SIGNING_PREFIX = "CAS-v0.1\n";
export const VERBS = ["read", "screen", "draft", "check", "file", "request_signature", "notify"] as const;
export type Verb = (typeof VERBS)[number];

export interface Signature {
	alg: "ed25519" | "secp256k1" | "ml-dsa-65";
	key_id: string;
	sig: string;
}

export interface Receipt {
	type: "cas.receipt";
	cas_version: typeof CAS_VERSION;
	receipt_id: string;
	mandate_id: string;
	agent_id: string;
	agent_key_id: string;
	seq: number;
	prev_hash: string;
	occurred_at: string;
	action: { verb: Verb; object_ref: string };
	evidence: { sha256: string; refs?: string[] };
	commitment: {
		is_commitment: boolean;
		human_signoff?: { signer_id_hash: string; signed_at: string; esign_ref?: string };
	};
	status: "recorded" | "awaiting_human" | "blocked" | "rejected";
	blocked_check_id?: string;
	hash: string;
	signatures: Signature[];
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const TS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const SIG = /^[A-Za-z0-9_-]{16,8192}$/;

export const sha256 = (data: string | Uint8Array): string =>
	`sha256:${createHash("sha256").update(data).digest("hex")}`;

/** C-1: sha256 of the JCS form without `hash` and `signatures`. */
export const recordHash = (record: object): string => {
	const { hash: _h, signatures: _s, ...rest } = record as Record<string, unknown>;
	return sha256(canonicalize(rest));
};

/** RFC 3339 UTC, second precision, trailing Z. */
export const casTimestamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export interface Issue {
	rule: string;
	path: string;
	message: string;
}

const KEYS = new Set([
	"type", "cas_version", "receipt_id", "mandate_id", "agent_id", "agent_key_id", "seq", "prev_hash",
	"occurred_at", "action", "evidence", "commitment", "status", "blocked_check_id", "anchor", "hash", "signatures",
]);
const REQUIRED = [...KEYS].filter((k) => k !== "blocked_check_id" && k !== "anchor");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[], path: string, out: Issue[]) => {
	for (const k of Object.keys(v)) if (!keys.includes(k)) out.push({ rule: "C-0", path: `${path}/${k}`, message: "unknown property" });
};

/** Validates one receipt. Returns every issue found (empty = valid). */
export function validateReceipt(r: unknown): Issue[] {
	const out: Issue[] = [];
	const bad = (rule: string, path: string, message: string) => out.push({ rule, path, message });
	if (!isObj(r)) return [{ rule: "C-0", path: "", message: "not an object" }];
	for (const k of Object.keys(r)) if (!KEYS.has(k)) bad("C-0", `/${k}`, "unknown property");
	for (const k of REQUIRED) if (!(k in r)) bad("schema", `/${k}`, "required");
	if (out.length) return out;
	if (r.type !== "cas.receipt") bad("schema", "/type", "must be cas.receipt");
	if (r.cas_version !== CAS_VERSION) bad("schema", "/cas_version", "must be 0.1");
	for (const k of ["receipt_id", "mandate_id", "agent_id", "agent_key_id"])
		if (typeof r[k] !== "string" || !ID.test(r[k] as string)) bad("schema", `/${k}`, "not an id");
	if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 0) bad("schema", "/seq", "not a count");
	if (typeof r.prev_hash !== "string" || !HASH.test(r.prev_hash)) bad("schema", "/prev_hash", "not a hash");
	if (typeof r.occurred_at !== "string" || !TS.test(r.occurred_at)) bad("schema", "/occurred_at", "not a UTC timestamp");
	const a = r.action;
	if (!isObj(a)) bad("schema", "/action", "not an object");
	else {
		only(a, ["verb", "object_ref"], "/action", out);
		if (!VERBS.includes(a.verb as Verb)) bad("schema", "/action/verb", "not a CAS verb");
		if (typeof a.object_ref !== "string" || !ID.test(a.object_ref)) bad("schema", "/action/object_ref", "not an id");
	}
	const e = r.evidence;
	if (!isObj(e)) bad("schema", "/evidence", "not an object");
	else {
		only(e, ["sha256", "refs"], "/evidence", out);
		if (typeof e.sha256 !== "string" || !HASH.test(e.sha256)) bad("schema", "/evidence/sha256", "not a hash");
		if (e.refs !== undefined && (!Array.isArray(e.refs) || e.refs.length > 32 || e.refs.some((x) => typeof x !== "string" || !ID.test(x))))
			bad("schema", "/evidence/refs", "not a list of at most 32 ids");
	}
	const c = r.commitment;
	let signedOff = false;
	let isCommitment = false;
	if (!isObj(c)) bad("schema", "/commitment", "not an object");
	else {
		only(c, ["is_commitment", "human_signoff"], "/commitment", out);
		if (typeof c.is_commitment !== "boolean") bad("schema", "/commitment/is_commitment", "not a boolean");
		isCommitment = c.is_commitment === true;
		if (c.human_signoff !== undefined) {
			const h = c.human_signoff;
			if (!isObj(h)) bad("schema", "/commitment/human_signoff", "not an object");
			else {
				only(h, ["signer_id_hash", "signed_at", "esign_ref"], "/commitment/human_signoff", out);
				if (typeof h.signer_id_hash !== "string" || !HASH.test(h.signer_id_hash)) bad("schema", "/commitment/human_signoff/signer_id_hash", "not a hash");
				if (typeof h.signed_at !== "string" || !TS.test(h.signed_at)) bad("schema", "/commitment/human_signoff/signed_at", "not a UTC timestamp");
				if (h.esign_ref !== undefined && (typeof h.esign_ref !== "string" || !ID.test(h.esign_ref))) bad("schema", "/commitment/human_signoff/esign_ref", "not an id");
				signedOff = true;
			}
		}
	}
	const statuses = ["recorded", "awaiting_human", "blocked", "rejected"];
	if (!statuses.includes(r.status as string)) bad("schema", "/status", "not a receipt status");
	if (isCommitment && !signedOff && r.status !== "awaiting_human") bad("R-1", "/status", "a commitment without human sign-off must be awaiting_human");
	if (r.status === "blocked" && !("blocked_check_id" in r)) bad("R-2", "/blocked_check_id", "a blocked receipt names its check");
	if ("blocked_check_id" in r && (typeof r.blocked_check_id !== "string" || !ID.test(r.blocked_check_id))) bad("schema", "/blocked_check_id", "not an id");
	if (typeof r.hash !== "string" || !HASH.test(r.hash)) bad("schema", "/hash", "not a hash");
	else {
		try {
			if (recordHash(r) !== r.hash) bad("C-1", "/hash", "hash does not match the record");
		} catch (err) {
			bad("C-0", "", (err as Error).message);
		}
	}
	const s = r.signatures;
	if (!Array.isArray(s) || s.length < 1 || s.length > 8) bad("schema", "/signatures", "1 to 8 signatures");
	else
		s.forEach((g, i) => {
			if (!isObj(g)) return bad("schema", `/signatures/${i}`, "not an object");
			only(g, ["alg", "key_id", "sig"], `/signatures/${i}`, out);
			if (!["ed25519", "secp256k1", "ml-dsa-65"].includes(g.alg as string)) bad("schema", `/signatures/${i}/alg`, "unknown alg");
			if (typeof g.key_id !== "string" || !ID.test(g.key_id)) bad("schema", `/signatures/${i}/key_id`, "not an id");
			if (typeof g.sig !== "string" || !SIG.test(g.sig)) bad("schema", `/signatures/${i}/sig`, "not base64url");
		});
	return out;
}

/** R-3 over a sequence for one mandate. Returns the first issue, or null. */
export function checkSequence(rs: Receipt[]): Issue | null {
	if (rs.length === 0) return { rule: "R-3", path: "", message: "empty sequence" };
	for (let i = 0; i < rs.length; i++) {
		const r = rs[i]!;
		const v = validateReceipt(r);
		if (v.length) return { ...v[0]!, path: `/${i}${v[0]!.path}` };
		if (r.mandate_id !== rs[0]!.mandate_id) return { rule: "R-3", path: `/${i}/mandate_id`, message: "mixed mandates" };
		if (r.seq !== i) return { rule: "R-3", path: `/${i}/seq`, message: `expected seq ${i}` };
		if (r.prev_hash !== (i === 0 ? ZERO_HASH : rs[i - 1]!.hash))
			return { rule: "R-3", path: `/${i}/prev_hash`, message: "does not link to the previous receipt" };
	}
	return null;
}

// --- signing ---------------------------------------------------------------

/** Your signing seam: sign these bytes with your agent key, wherever it lives. */
export type Signer = (bytes: Uint8Array) => Promise<Signature> | Signature;

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI = Buffer.from("302a300506032b6570032100", "hex");

const strictB64u = (s: string): Buffer => {
	if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid base64url");
	const b = Buffer.from(s, "base64url");
	if (b.toString("base64url") !== s) throw new Error("non-canonical base64url");
	return b;
};

/** An ed25519 signer over a raw 32-byte seed you hold. The kit never stores it. */
export function ed25519Signer(seedB64u: string, keyId: string): Signer {
	const seed = strictB64u(seedB64u);
	if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
	const key = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
	return (bytes) => ({ alg: "ed25519", key_id: keyId, sig: sign(null, bytes, key).toString("base64url") });
}

export function ed25519PublicKey(seedB64u: string): string {
	const key = createPrivateKey({ key: Buffer.concat([PKCS8, strictB64u(seedB64u)]), format: "der", type: "pkcs8" });
	return (createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI.length).toString("base64url");
}

/** C-2: recomputes the hash first; a valid signature over a stale hash fails. */
export function verifyEd25519(r: Receipt, keyId: string, publicKeyB64u: string): boolean {
	try {
		if (recordHash(r) !== r.hash) return false;
		const entry = r.signatures.find((s) => s.key_id === keyId && s.alg === "ed25519");
		if (!entry) return false;
		const raw = strictB64u(publicKeyB64u);
		if (raw.length !== 32) return false;
		const key = createPublicKey({ key: Buffer.concat([SPKI, raw]), format: "der", type: "spki" });
		return verify(null, Buffer.from(SIGNING_PREFIX + r.hash, "utf8"), key, strictB64u(entry.sig));
	} catch {
		return false;
	}
}

// --- the log a template appends to -----------------------------------------

/**
 * Digest of what an action looked at. API responses carry decimals, which
 * CAS records may not, so evidence is digested as text (a string as-is,
 * anything else as its JSON text) rather than canonicalised. The record
 * itself is still JCS-hashed (C-1).
 */
export const evidenceDigest = (e: unknown): string =>
	sha256(typeof e === "string" ? e : (JSON.stringify(e) ?? "null"));

export interface ActionInput {
	verb: Verb;
	objectRef: string;
	/** What the action looked at or produced; only its hash is recorded. */
	evidence: unknown;
	refs?: string[];
	/** True for anything that would bind your principal. Then the receipt waits for a human. */
	isCommitment?: boolean;
	/** Set when a check stopped the action (R-2). */
	blockedCheckId?: string;
}

/**
 * A hash-linked receipt sequence for one mandate (R-3), kept by you. The kit
 * keeps it in memory; persisting it is your choice and your storage.
 */
export class ReceiptLog {
	readonly receipts: Receipt[] = [];
	private readonly ids: { mandateId: string; agentId: string; agentKeyId: string };
	private readonly signer: Signer;
	private readonly now: () => Date;
	constructor(
		ids: { mandateId: string; agentId: string; agentKeyId: string },
		signer: Signer,
		now: () => Date = () => new Date()
	) {
		for (const [k, v] of Object.entries(ids)) if (!ID.test(v)) throw new Error(`${k} is not a CAS id`);
		this.ids = ids;
		this.signer = signer;
		this.now = now;
	}

	async record(a: ActionInput): Promise<Receipt> {
		const seq = this.receipts.length;
		const status: Receipt["status"] = a.blockedCheckId ? "blocked" : a.isCommitment ? "awaiting_human" : "recorded";
		const body: Omit<Receipt, "hash" | "signatures"> = {
			type: "cas.receipt",
			cas_version: CAS_VERSION,
			receipt_id: `${this.ids.mandateId}.${seq}`,
			mandate_id: this.ids.mandateId,
			agent_id: this.ids.agentId,
			agent_key_id: this.ids.agentKeyId,
			seq,
			prev_hash: seq === 0 ? ZERO_HASH : this.receipts[seq - 1]!.hash,
			occurred_at: casTimestamp(this.now()),
			action: { verb: a.verb, object_ref: a.objectRef },
			evidence: a.refs ? { sha256: evidenceDigest(a.evidence), refs: a.refs } : { sha256: evidenceDigest(a.evidence) },
			commitment: { is_commitment: a.isCommitment === true },
			status,
			...(a.blockedCheckId ? { blocked_check_id: a.blockedCheckId } : {}),
		};
		const hash = recordHash(body);
		const sig = await this.signer(Buffer.from(SIGNING_PREFIX + hash, "utf8"));
		const r: Receipt = { ...body, hash, signatures: [sig] };
		const issues = validateReceipt(r);
		if (issues.length) throw new Error(`receipt refused: ${issues.map((i) => `${i.rule} ${i.path} ${i.message}`).join("; ")}`);
		this.receipts.push(r);
		return r;
	}
}
