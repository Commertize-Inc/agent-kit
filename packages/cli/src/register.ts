// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { ApiError, CommertizeClient, KitConfigError } from "./client.ts";
import { ROUTES, RouteMissingError } from "./routes.ts";

export interface WorkTask {
	task_id: string;
	task_class: string;
	status: string;
	required_kya_tier: string;
	deadline?: string;
}

export interface RegisterOutcome {
	passport: { passportId: string; agentAddress: string; reused: boolean };
	mandate: { set: false; reason: string };
	task: { taskId: string; taskClass: string } | null;
	taskNote: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Registers your agent's wallet under your own account, reports why the task
 * mandate cannot be set (route Not open), and finds the first open, unexpired Work task
 * (optionally only of the classes you name). Re-running is safe: an address
 * already registered is reused, never registered twice.
 */
export async function register(
	client: CommertizeClient,
	agentAddress: string,
	/** Only offer tasks of these classes (your choice; empty = any open task). */
	taskClasses: string[] = [],
	now: () => Date = () => new Date()
): Promise<RegisterOutcome> {
	if (!ADDRESS.test(agentAddress)) throw new KitConfigError("--agent-address must be a 0x-prefixed 20-byte address");
	if (!client.env.sessionToken) throw new KitConfigError("register needs COMMERTIZE_SESSION_TOKEN (your own session)");

	// 1. Wallet. A 409 means the server already holds this address: find the active row and reuse it.
	let passport: RegisterOutcome["passport"];
	try {
		const p = await client.call<{ passportId: string; agentAddress: string }>("passportCreate", { body: { agentAddress } });
		passport = { passportId: p.passportId, agentAddress: p.agentAddress, reused: false };
	} catch (e) {
		if (!(e instanceof ApiError) || e.status !== 409) throw e;
		const own = await client.call<{ agents?: { passportId: string; agentAddress: string; kyaStatus: string }[] }>(
			"principalAgents",
			{ query: { limit: "50" } }
		);
		const hit = (own.agents ?? []).find(
			(a) => a.agentAddress.toLowerCase() === agentAddress.toLowerCase() && a.kyaStatus === "active"
		);
		if (!hit) throw new Error("the server refused this address (409) and no active registration for it was found");
		passport = { passportId: hit.passportId, agentAddress: hit.agentAddress, reused: true };
	}

	// 2. Mandate. The task-mandate route is Not open. Never fall back to the investment mandate route.
	const mandate = { set: false as const, reason: new RouteMissingError(ROUTES.taskMandateCreate).message };

	// 3. First open Work task.
	const board = await client.call<{ tasks?: WorkTask[] }>("workTasks");
	const t = now().getTime();
	const task =
		(board.tasks ?? []).find(
			(x) =>
				x.status === "open" &&
				(taskClasses.length === 0 || taskClasses.includes(x.task_class)) &&
				(!x.deadline || Date.parse(x.deadline) > t)
		) ?? null;
	const taskNote = task
		? `First open task: ${task.task_id}. ${new RouteMissingError(ROUTES.workSubmit).message}`
		: "No open Work task matches right now.";
	return { passport, mandate, task: task ? { taskId: task.task_id, taskClass: task.task_class } : null, taskNote };
}
