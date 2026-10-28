// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `serve`: the event stream over HTTP, for a harness that would rather
 * connect than spawn. Loopback only, read only, no credentials.
 *
 *   GET /events   NDJSON, one kit event per line, from one shared poller
 *   GET /healthz  {"ok":true,...}
 *
 * Binds 127.0.0.1 and nothing else. A request whose Host is not this
 * loopback address and port is refused (DNS rebinding), and so is any
 * request carrying an Origin header (a web page cannot read the stream).
 * The stream carries only public Work board events; no credential, token
 * or header value is ever written to it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { KitEvent } from "./events.ts";

export const SERVE_HOST = "127.0.0.1";
export const SERVE_MAX_CLIENTS = 8;
/** Recent events replayed to a new client so it does not start blind. */
export const SERVE_REPLAY = 50;

export class EventHub {
	private readonly clients = new Set<ServerResponse>();
	private readonly recent: KitEvent[] = [];
	publish(e: KitEvent): void {
		this.recent.push(e);
		if (this.recent.length > SERVE_REPLAY) this.recent.shift();
		const line = JSON.stringify(e) + "\n";
		for (const c of this.clients) c.write(line);
	}
	get size(): number {
		return this.clients.size;
	}
	attach(res: ServerResponse): boolean {
		if (this.clients.size >= SERVE_MAX_CLIENTS) return false;
		this.clients.add(res);
		for (const e of this.recent) res.write(JSON.stringify(e) + "\n");
		res.on("close", () => this.clients.delete(res));
		return true;
	}
	closeAll(): void {
		for (const c of this.clients) c.end();
		this.clients.clear();
	}
}

function deny(res: ServerResponse, status: number, error: string): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify({ ok: false, error }) + "\n");
}

/** Exactly the Host values a loopback client sends for this port. */
export function allowedHosts(port: number): ReadonlySet<string> {
	return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

export function makeHandler(hub: EventHub, port: number, info: () => Record<string, unknown>) {
	const hosts = allowedHosts(port);
	return (req: IncomingMessage, res: ServerResponse): void => {
		const host = req.headers.host;
		if (typeof host !== "string" || !hosts.has(host.toLowerCase())) return deny(res, 421, "host not allowed");
		if (req.headers.origin !== undefined) return deny(res, 403, "browser origins are refused");
		if (req.method !== "GET") return deny(res, 405, "GET only");
		const path = (req.url ?? "").split("?")[0];
		if (path === "/healthz") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify({ ok: true, clients: hub.size, ...info() }) + "\n");
			return;
		}
		if (path === "/events") {
			if (hub.size >= SERVE_MAX_CLIENTS) return deny(res, 503, "too many clients");
			res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" });
			hub.attach(res);
			return;
		}
		deny(res, 404, "not found");
	};
}
