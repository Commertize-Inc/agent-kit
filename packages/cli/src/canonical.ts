// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// Copied unchanged from Commertize-Inc commertize-agents packages/sdk-ts/src/canonical.ts.

/**
 * JSON canonicalisation for CAS records (RFC 8785, JCS).
 *
 * CAS v0 records contain no non-integer numbers, so the number rule of JCS
 * reduces to "integers in the safe range, written in decimal". Anything else
 * (floats, NaN, Infinity, bigint, undefined, functions, symbols) is refused
 * rather than silently coerced: a hash over a value two implementations
 * serialise differently is worthless.
 */

export class CanonicalizationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CanonicalizationError";
	}
}

/** Compare by UTF-16 code units, as RFC 8785 section 3.2.3 requires. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * RFC 8785 requires an error on lone surrogates; JSON.stringify would emit
 * them as \udXXX escapes instead. Known blind spot of canonicalize(): plain
 * JSON.parse turns `1.0` or `1e0` into 1 before this code sees it. Use
 * parseRecord() on raw text to reject that notation (spec C-0).
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const jsonString = (s: string): string => {
	if (LONE_SURROGATE.test(s)) throw new CanonicalizationError("lone surrogate in string");
	return JSON.stringify(s);
};

export const canonicalize = (value: unknown): string => {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "string":
			return jsonString(value);
		case "number":
			if (!Number.isSafeInteger(value)) {
				throw new CanonicalizationError(
					`CAS records carry integers only; got ${String(value)}. Write decimals as strings.`
				);
			}
			// -0 serialises as 0 under JCS.
			return Object.is(value, -0) ? "0" : String(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map((v) => canonicalize(v)).join(",")}]`;
			}
			const proto = Object.getPrototypeOf(value);
			if (proto !== Object.prototype && proto !== null) {
				throw new CanonicalizationError("Only plain objects can be canonicalised.");
			}
			const entries = Object.entries(value as Record<string, unknown>);
			for (const [k, v] of entries) {
				if (v === undefined) {
					throw new CanonicalizationError(`Property "${k}" is undefined; omit it instead.`);
				}
			}
			entries.sort(([a], [b]) => compareKeys(a, b));
			return `{${entries.map(([k, v]) => `${jsonString(k)}:${canonicalize(v)}`).join(",")}}`;
		}
		default:
			throw new CanonicalizationError(`Cannot canonicalise a value of type ${typeof value}.`);
	}
};

const INTEGER_TEXT = /^-?(0|[1-9][0-9]*)$/;
type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * Parse the raw JSON text of a CAS record, enforcing spec C-0 at the text
 * level: every number must be written as a plain integer (no fraction or
 * exponent, so `1.0` and `1e0` are refused), and no string may hold a lone
 * surrogate. Needs a runtime whose JSON.parse passes the source text to the
 * reviver (Node 21 and later); refuses rather than skip the check otherwise.
 */
export const parseRecord = (text: string): unknown => {
	let sawSource = true;
	const reviver: Reviver = (_key, value, context) => {
		if (typeof value === "number") {
			if (typeof context?.source !== "string") sawSource = false;
			else if (!INTEGER_TEXT.test(context.source)) {
				throw new CanonicalizationError(`number ${context.source} must be written as a plain integer`);
			}
		}
		return value;
	};
	const value = (JSON.parse as (text: string, reviver: Reviver) => unknown)(text, reviver);
	if (!sawSource) throw new CanonicalizationError("this runtime cannot check number notation (JSON.parse gives no source text)");
	canonicalize(value);
	return value;
};
