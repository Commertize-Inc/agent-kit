// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Sponsor Scout: finds real-asset sponsors from sources you choose, checks
 * them against the sponsors already listed on Commertize, and drafts an
 * introduction for a human on your side to review. It never contacts anyone
 * and never submits on a sponsor's behalf.
 */
import { callOrStop, newResult, type Template } from "@commertize/agent-kit";

interface PublicListing {
	sponsor?: { name?: string } | null;
	sponsorName?: string;
}

export const sponsorScout: Template = {
	name: "sponsor-scout",
	routes: ["listings", "sponsorSubmission"],
	async run(ctx) {
		const res = newResult();
		const feed = await callOrStop<PublicListing[] | { listings?: PublicListing[] }>(ctx, res, "listings");
		const rows = Array.isArray(feed) ? feed : (feed?.listings ?? []);
		const known = [...new Set(rows.map((l) => l.sponsor?.name ?? l.sponsorName).filter((n): n is string => !!n))];
		res.receipts.push(await ctx.log.record({ verb: "read", objectRef: "commertize.listings", evidence: rows }));

		// YOUR MODEL CALL GOES HERE (ctx.model). Your sources, your model, your keys.
		const draft = await ctx.model({
			task: "sponsor-scout.draft",
			instructions:
				"From the public sources you were given, name one real-asset sponsor that is not in `known`, " +
				"with the primary source for each fact. Draft a short, factual introduction for a human to review. " +
				"Make no statement about performance or outcomes.",
			data: { known },
		});
		res.output.push(draft);
		res.receipts.push(await ctx.log.record({ verb: "draft", objectRef: "sponsor-scout.draft", evidence: draft }));

		// Submitting an asset application is a human step, and its route is not on
		// main yet, so this stops here and says why.
		await callOrStop(ctx, res, "sponsorSubmission", { body: { draft } });
		return res;
	},
};
