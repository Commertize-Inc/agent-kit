// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import type { CommertizeClient } from "./client.ts";
import type { ReceiptLog, Receipt } from "./cas.ts";
import { RouteMissingError, type RouteId } from "./routes.ts";

/**
 * YOUR MODEL CALL GOES HERE.
 *
 * Every template hands its model step to this function and nothing else. Use
 * any model, any framework, any provider, on your own keys. The kit never
 * sees your model credentials. Return plain text; the template decides what
 * to do with it, and every decision is recorded as a CAS receipt.
 */
export type ModelSeam = (prompt: { task: string; instructions: string; data: unknown }) => Promise<string>;

/** A model seam that refuses to run, so a template never acts on an unwired model. */
export const unwiredModel: ModelSeam = async () => {
	throw new Error("No model wired: pass your own ModelSeam to run(). See the template README.");
};

export interface TemplateContext {
	client: CommertizeClient;
	log: ReceiptLog;
	model: ModelSeam;
}

export interface TemplateResult {
	receipts: Receipt[];
	/** Steps that stopped because a route is not on Commertize main, with the reason. */
	stopped: { route: RouteId; reason: string }[];
	/** Plain-text output for you to read. Nothing is sent or published. */
	output: string[];
}

/**
 * Calls a route; if it is not on Commertize main, records a blocked receipt
 * naming it, adds it to `stopped`, and returns null. Any other error throws.
 */
export async function callOrStop<T>(
	ctx: TemplateContext,
	res: TemplateResult,
	route: RouteId,
	opts: Parameters<CommertizeClient["call"]>[1] = {}
): Promise<T | null> {
	try {
		return await ctx.client.call<T>(route, opts);
	} catch (e) {
		if (!(e instanceof RouteMissingError)) throw e;
		res.stopped.push({ route, reason: e.message });
		res.receipts.push(
			await ctx.log.record({
				verb: "check",
				objectRef: `route.${route}`,
				evidence: { route, reason: e.message },
				blockedCheckId: `route_missing.${route}`,
			})
		);
		return null;
	}
}

export const newResult = (): TemplateResult => ({ receipts: [], stopped: [], output: [] });

export interface Template {
	name: string;
	/** Every route the template calls, in call order. */
	routes: RouteId[];
	run(ctx: TemplateContext): Promise<TemplateResult>;
}
