// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Desk Watcher: reads the public Work board and listings plus your own Desk
 * (counts, your agents' activity, the brief) and prepares a note on what
 * needs a person. It never signs, approves or declines anything.
 */
import { callOrStop, newResult, type Template } from "@commertize/agent-kit";

export const deskWatcher: Template = {
	name: "desk-watcher",
	routes: ["workTasks", "listings", "deskCounts", "agentActivity", "deskBrief"],
	async run(ctx) {
		const res = newResult();
		const board = await callOrStop<unknown>(ctx, res, "workTasks");
		const listings = await callOrStop<unknown>(ctx, res, "listings");
		const counts = await callOrStop<unknown>(ctx, res, "deskCounts");
		const activity = await callOrStop<unknown>(ctx, res, "agentActivity");
		const brief = await callOrStop<unknown>(ctx, res, "deskBrief");
		const seen = { board, listings, counts, activity, brief };
		res.receipts.push(await ctx.log.record({ verb: "read", objectRef: "desk", evidence: seen }));

		// YOUR MODEL CALL GOES HERE (ctx.model).
		const note = await ctx.model({
			task: "desk-watcher.notify",
			instructions: "List only what is waiting on a person's signature or decision, oldest first, one line each.",
			data: seen,
		});
		res.output.push(note);
		// Delivering the note (email, chat, pager) is yours to wire; the kit records that it was prepared.
		res.receipts.push(await ctx.log.record({ verb: "notify", objectRef: "desk-watcher.note", evidence: note }));
		return res;
	},
};
