// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Every Commertize route this kit calls, in one table.
 *
 * A row is `live` when the route is available on the public Commertize API
 * as of ROUTES_CHECKED_AT.date. Some live routes can be switched off on a
 * deployment and then answer 404 (`switchable`). A row is `missing` when it
 * is Not open; calling it throws RouteMissingError before any
 * network call. The kit never substitutes sample data for a missing route.
 */

export type Auth = "none" | "api_key" | "session";

export interface Route {
	id: string;
	method: "GET" | "POST";
	path: string;
	auth: Auth;
	status: "live" | "missing";
	/** A live route that a deployment can switch off (it then answers 404). */
	switchable?: true;
	/** For routes that are Not open: the public status. */
	pending?: string;
	note: string;
}

export const ROUTES_CHECKED_AT = { date: "2026-10-26" } as const;

export const ROUTES = {
	passportCreate: {
		id: "passportCreate",
		method: "POST",
		path: "/mandates/principal/passports",
		auth: "session",
		status: "live",
		switchable: true,
		note: "Registers your agent's wallet address under your signed-in account. Body: { agentAddress }.",
	},
	principalAgents: {
		id: "principalAgents",
		method: "GET",
		path: "/mandates/principal/agents",
		auth: "session",
		status: "live",
		switchable: true,
		note: "Lists the agents registered under your own account and their status.",
	},
	kyaChecks: {
		id: "kyaChecks",
		method: "GET",
		path: "/kya/passports/:pid/checks",
		auth: "session",
		status: "live",
		switchable: true,
		note: "The KYA check record of one of your own agents (check id, result, policy version, date). Read only.",
	},
	taskMandateCreate: {
		id: "taskMandateCreate",
		method: "POST",
		path: "/agents/v1/task-mandates",
		auth: "session",
		status: "missing",
		pending: "Not open",
		note: "A CAS task-class mandate (read, screen, draft, check, notify).",
	},
	pairingStart: {
		id: "pairingStart",
		method: "POST",
		path: "/agents/v1/pairings",
		auth: "none",
		status: "missing",
		pending: "Not open",
		note: "Headless pairing: your agent key asks, you approve in the dashboard. Answers { requestId, signinUrl, expiresIn }.",
	},
	pairingStatus: {
		id: "pairingStatus",
		method: "GET",
		path: "/agents/v1/pairings/:requestId",
		auth: "none",
		status: "missing",
		pending: "Not open",
		note: "State of a pairing request: pending, approved, denied or expired.",
	},
	agentMe: {
		id: "agentMe",
		method: "GET",
		path: "/agents/v1/me",
		auth: "none",
		status: "missing",
		pending: "Not open",
		note: "What this agent is and which tasks it qualifies for.",
	},
	workTasks: {
		id: "workTasks",
		method: "GET",
		path: "/work/v1/tasks",
		auth: "none",
		status: "live",
		switchable: true,
		note: "The public Commertize Work board. May be empty. Answered 404 on api.commertize.com on 2026-10-27 (built, not released).",
	},
	workSubmit: {
		id: "workSubmit",
		method: "POST",
		path: "/work/v1/tasks/:taskId/submissions",
		auth: "session",
		status: "missing",
		pending: "Not open: answers 501 until claims open",
		note: "Submitting work for a task.",
	},
	listings: {
		id: "listings",
		method: "GET",
		path: "/listings",
		auth: "none",
		status: "live",
		note: "The public marketplace feed. No key needed.",
	},
	partnerListings: {
		id: "partnerListings",
		method: "GET",
		path: "/partner/listings",
		auth: "api_key",
		status: "live",
		note: "Listings for holders of an issued API key. Rate limited per key.",
	},
	news: {
		id: "news",
		method: "GET",
		path: "/news",
		auth: "none",
		status: "live",
		note: "Published Commertize articles.",
	},
	dataApiUsage: {
		id: "dataApiUsage",
		method: "GET",
		path: "/api-keys/:id/usage",
		auth: "session",
		status: "missing",
		pending: "Not open",
		note: "Per-key Data API usage.",
	},
	sponsorSubmission: {
		id: "sponsorSubmission",
		method: "POST",
		path: "/agents/submissions",
		auth: "api_key",
		status: "missing",
		pending: "Not open",
		note: "Filing a candidate asset for sponsor review.",
	},
	deskCounts: {
		id: "deskCounts",
		method: "GET",
		path: "/desk/counts",
		auth: "session",
		status: "live",
		note: "Counts for your own Desk. Empty when mandates are switched off.",
	},
	agentActivity: {
		id: "agentActivity",
		method: "GET",
		path: "/agents/activity",
		auth: "session",
		status: "live",
		note: "Activity of your own agents.",
	},
	deskBrief: {
		id: "deskBrief",
		method: "GET",
		path: "/desk/brief",
		auth: "session",
		status: "live",
		note: "The Desk brief and latest articles for a signed-in user.",
	},
} as const satisfies Record<string, Route>;

export type RouteId = keyof typeof ROUTES;

export class RouteMissingError extends Error {
	readonly route: Route;
	constructor(route: Route) {
		super(
			`${route.method} ${route.path}: ${route.pending ?? "Not open"} ` +
				`(status as of ${ROUTES_CHECKED_AT.date}). This kit does not substitute sample data; ` +
				`the step stops here.`
		);
		this.name = "RouteMissingError";
		this.route = route;
	}
}
