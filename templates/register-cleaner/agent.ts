// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Register Cleaner: data upkeep. Reads the public Commertize Work board,
 * takes the first open task, has your model check the source the task names
 * against its snapshot hash, and prepares a report of what changed. Claiming
 * and submitting is gated on Commertize today; the step stops and says why.
 */
import { callOrStop, newResult, type Template } from "@commertize/agent-kit";

interface Board {
	payouts_enabled?: boolean;
	tasks?: {
		task_id: string;
		task_class: string;
		status: string;
		deadline?: string;
		source?: { dataset_key: string; snapshot_sha256: string };
		acceptance?: { method: string; value_kind: string; tolerance: string };
	}[];
}

export const registerCleaner: Template = {
	name: "register-cleaner",
	routes: ["workTasks", "workSubmit"],
	async run(ctx) {
		const res = newResult();
		const board = await callOrStop<Board>(ctx, res, "workTasks");
		const now = Date.now();
		const task = (board?.tasks ?? []).find((t) => t.status === "open" && (!t.deadline || Date.parse(t.deadline) > now));
		res.receipts.push(await ctx.log.record({ verb: "read", objectRef: "work.board", evidence: board }));
		if (!task) {
			res.output.push("No open Work task right now.");
			return res;
		}

		// YOUR MODEL CALL GOES HERE (ctx.model). Fetch the source yourself; the kit fetches nothing but Commertize.
		const report = await ctx.model({
			task: "register-cleaner.check-source",
			instructions:
				"Fetch the primary source for `source.dataset_key`, compare it with the snapshot named by `source.snapshot_sha256`, " +
				"and report each changed field with its source URL and retrieval time. Report only what the source shows.",
			data: { task },
		});
		res.output.push(report);
		res.receipts.push(await ctx.log.record({ verb: "check", objectRef: task.task_id, evidence: report }));

		await callOrStop(ctx, res, "workSubmit", { params: { taskId: task.task_id }, body: { report } });
		return res;
	},
};
