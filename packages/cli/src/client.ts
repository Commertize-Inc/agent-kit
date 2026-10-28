// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { ROUTES, RouteMissingError, type Route, type RouteId } from "./routes.ts";

/**
 * Environment the kit reads. Nothing here is ever written to disk, logged,
 * or sent anywhere except the Commertize API base you configure.
 *
 *  COMMERTIZE_API_BASE_URL  default https://api.commertize.com
 *  COMMERTIZE_SESSION_TOKEN your own signed-in session token (Authorization: Bearer)
 *  COMMERTIZE_API_KEY       your own issued API key (x-api-key)
 */
export interface KitEnv {
	baseUrl: string;
	sessionToken?: string;
	apiKey?: string;
}

export class KitConfigError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "KitConfigError";
	}
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Hosts your credentials may be sent to without an explicit override. */
export const ALLOWED_HOSTS = new Set(["api.commertize.com"]);

/**
 * `allowHost`: one extra host you name explicitly (CLI `--allow-host`). It
 * must equal the base URL's host exactly; the override is announced on
 * stderr so a redirected base can never pass silently.
 */
export function readEnv(
	env: Record<string, string | undefined> = process.env,
	allowHost?: string,
	warn: (msg: string) => void = (m) => console.error(m)
): KitEnv {
	const raw = (env.COMMERTIZE_API_BASE_URL ?? "https://api.commertize.com").trim();
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new KitConfigError("COMMERTIZE_API_BASE_URL is not a URL");
	}
	// A token over plain http leaks it. Plain http only to this machine.
	if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname)))
		throw new KitConfigError("COMMERTIZE_API_BASE_URL must be https (http only for localhost)");
	if (u.username || u.password || u.search || u.hash)
		throw new KitConfigError("COMMERTIZE_API_BASE_URL must not carry credentials, a query or a fragment");
	const host = u.hostname.toLowerCase();
	if (!ALLOWED_HOSTS.has(host) && !LOOPBACK.has(host)) {
		if (!allowHost || allowHost.trim().toLowerCase() !== host)
			throw new KitConfigError(
				`COMMERTIZE_API_BASE_URL host "${host}" is not api.commertize.com or localhost; ` +
					`your credentials are not sent there unless you pass --allow-host ${host}`
			);
		warn(`commertize-agent: --allow-host in effect; credentials will be sent to ${host}`);
	}
	const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
	return {
		baseUrl: u.origin + u.pathname.replace(/\/+$/, ""),
		sessionToken: nonEmpty(env.COMMERTIZE_SESSION_TOKEN),
		apiKey: nonEmpty(env.COMMERTIZE_API_KEY),
	};
}

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(route: Route, status: number, body: unknown) {
		const hint =
			status === 404 && "switchable" in route && route.switchable
				? " (this route answers 404 while it is switched off on this deployment)"
				: "";
		super(`${route.method} ${route.path} answered ${status}${hint}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

export type Fetch = typeof fetch;

export interface CallOptions {
	params?: Record<string, string>;
	query?: Record<string, string>;
	body?: unknown;
}

export class CommertizeClient {
	readonly env: KitEnv;
	private readonly fetchImpl: Fetch;
	private readonly routes: Readonly<Record<string, Route>>;
	// (no TypeScript parameter properties anywhere: the sources run under Node type stripping)
	/**
	 * `routes` is a library seam (tests, and embedders tracking a newer API).
	 * The CLI never sets it: no flag or environment variable reaches it.
	 */
	constructor(env: KitEnv, fetchImpl: Fetch = fetch, routes: Readonly<Record<string, Route>> = ROUTES) {
		this.env = env;
		this.fetchImpl = fetchImpl;
		this.routes = routes;
	}

	/** Calls a route from the table. A missing route throws before any network call. */
	async call<T = unknown>(id: RouteId, opts: CallOptions = {}): Promise<T> {
		const route: Route | undefined = this.routes[id];
		if (!route) throw new KitConfigError(`route ${id} is not in the routes table`);
		if (route.status !== "live") throw new RouteMissingError(route);
		const headers: Record<string, string> = {
			accept: "application/json",
			"user-agent": "commertize-agent-kit/0.2.0",
		};
		if (route.auth === "session") {
			if (!this.env.sessionToken)
				throw new KitConfigError(`${route.path} needs COMMERTIZE_SESSION_TOKEN (your own session)`);
			headers.authorization = `Bearer ${this.env.sessionToken}`;
		} else if (route.auth === "api_key") {
			if (!this.env.apiKey) throw new KitConfigError(`${route.path} needs COMMERTIZE_API_KEY (your own key)`);
			headers["x-api-key"] = this.env.apiKey;
		}
		let path: string = route.path;
		for (const [k, v] of Object.entries(opts.params ?? {}))
			path = path.replace(`:${k}`, encodeURIComponent(v));
		if (path.includes("/:")) throw new KitConfigError(`missing path parameter for ${route.path}`);
		const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
		let body: string | undefined;
		if (opts.body !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		const res = await this.fetchImpl(this.env.baseUrl + path + qs, {
			method: route.method,
			headers,
			body,
			redirect: "error",
		});
		const text = await res.text();
		let parsed: unknown = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			parsed = null;
		}
		if (!res.ok) throw new ApiError(route, res.status, parsed);
		return parsed as T;
	}
}
