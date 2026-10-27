// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Data Consumer: reads free Commertize data (listings, articles), hands it to
 * your model for the summary you asked for, then checks the key's usage.
 */
import { callOrStop, newResult, type Template } from "@commertize/agent-kit";

export const dataConsumer: Template = {
	name: "data-consumer",
	routes: ["listings", "news", "dataApiUsage"],
	async run(ctx) {
		const res = newResult();
		const listings = await callOrStop<unknown>(ctx, res, "listings");
		res.receipts.push(await ctx.log.record({ verb: "read", objectRef: "listings", evidence: listings }));
		const news = await callOrStop<unknown>(ctx, res, "news");
		res.receipts.push(await ctx.log.record({ verb: "read", objectRef: "news", evidence: news }));

		// YOUR MODEL CALL GOES HERE (ctx.model).
		const summary = await ctx.model({
			task: "data-consumer.summarise",
			instructions: "Summarise what changed, citing the record each sentence comes from. No predictions, no advice.",
			data: { listings, news },
		});
		res.output.push(summary);
		res.receipts.push(await ctx.log.record({ verb: "screen", objectRef: "data-consumer.summary", evidence: summary }));

		// Per-key usage is not yet available on the public API; the step stops and says why.
		await callOrStop(ctx, res, "dataApiUsage", { params: { id: "self" } });
		return res;
	},
};
