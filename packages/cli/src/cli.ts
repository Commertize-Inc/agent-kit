#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { ApiError, CommertizeClient, KitConfigError, readEnv } from "./client.ts";
import { AUTH_EXIT, authComplete, authStart, checkRequestId, type AuthStartResult, type CredentialSink } from "./auth.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { history, listen, POLL_FLOOR_MS, watchStop, type KitEvent } from "./events.ts";
import { EventHub, makeHandler, SERVE_HOST } from "./serve.ts";
import { checkName, KEY_NAMES, KEYCHAIN_SERVICE, type KeyName, type Keychain } from "./keychain.ts";
import { init, TEMPLATES } from "./init.ts";
import { MCP_TOOLS_CHECKED_AT, mcpClientConfig } from "./mcp.ts";
import { register } from "./register.ts";
import { ROUTES, ROUTES_CHECKED_AT, RouteMissingError } from "./routes.ts";

export const KIT_VERSION = "0.2.0";

/** Every `--json` result carries this schema id. */
export const JSON_SCHEMA = "commertize.agent-kit.cli.v1";

export const COMMANDS = ["help", "version", "init", "auth", "register", "events", "job", "serve", "routes", "mcp", "skill", "configure"] as const;

const USAGE = `commertize-agent ${KIT_VERSION}

  commertize-agent init <template> [dir]     copy a template (${TEMPLATES.join(", ")})
  commertize-agent register --agent-address 0x... [--task-class c]... [--allow-host h]
                                             register your agent's wallet on Commertize and
                                             find the first open Work task
  commertize-agent auth start [--no-wait]    start sign-in: prints the link and a request id, exits
  commertize-agent auth complete --request <id> [--wait | --no-wait] [--timeout s]
                                             check (or wait for) that sign-in; exit 0 approved,
                                             5 pending, 6 denied, 7 expired, 8 timed out
  commertize-agent register ... --no-wait    with no session: start sign-in instead (exit 5)
  commertize-agent events listen [--interval s] [--once]
                                             Work board changes as they happen (polls, floor 15 s);
                                             with --json, one event object per line (NDJSON)
  commertize-agent job watch <taskId>        one task's changes, until it reaches a final state
  commertize-agent job history <taskId> --from <file.ndjson>
                                             that task's events from a file events listen wrote
  commertize-agent serve [--port 8787]       the event stream at http://127.0.0.1:<port>/events
                                             (loopback only, read only, no credentials)
  commertize-agent routes                    every route the kit calls, live or not open
  commertize-agent mcp <template> --server /abs/path/mcp-server/dist/index.js
                                             MCP client config for a template, and the server
                                             tools and gates it uses (opens no gate)
  commertize-agent configure [--session-token-stdin | --api-key-stdin | --clear NAME]
                                             keep your credentials in the OS keychain (macOS);
                                             values are read from stdin only, never printed
  commertize-agent skill print             the operating guide for a coding agent (SKILL.md)
  commertize-agent version | help

  --json  on any command: print exactly one JSON object per result on stdout
          ({ schema, command, ok, exit_code, data, error, next_step })

Environment (read, never stored): COMMERTIZE_API_BASE_URL, COMMERTIZE_SESSION_TOKEN, COMMERTIZE_API_KEY
`;

const HELP_NEXT = "commertize-agent help --json";

export type Out = (line: string) => void;

/** What every command returns. Text and JSON output are both rendered from this. */
export interface Result {
	command: string;
	exit_code: number;
	data?: unknown;
	error?: { code: "usage" | "config" | "route_missing" | "api" | "internal" | "timeout" | "denied" | "expired"; message: string; status?: number };
	/** One instruction for the caller (a command line or a sentence), or null when there is nothing left to do. */
	next_step: string | null;
	/** Text-mode rendering (stdout lines, stderr lines). JSON mode ignores both. */
	text?: string[];
	textErr?: string[];
}

class UsageError extends Error {}

/** Strict parse: an unknown or misspelt flag is a usage error, never ignored. */
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
function parse(args: string[], options: ParseArgsOptionsConfig, allowPositionals = false): { values: Values; positionals: string[] } {
	try {
		const r = parseArgs({ args, options, allowPositionals, strict: true });
		return { values: r.values as Values, positionals: r.positionals };
	} catch (e) {
		throw new UsageError((e as Error).message);
	}
}

/** Removes every `--json` (anywhere before a bare `--`) and reports whether one was present. */
export function takeJsonFlag(argv: string[]): { json: boolean; rest: string[] } {
	const rest: string[] = [];
	let json = false;
	let passthrough = false;
	for (const a of argv) {
		if (!passthrough && a === "--json") json = true;
		else {
			if (a === "--") passthrough = true;
			rest.push(a);
		}
	}
	return { json, rest };
}

function errorResult(command: string, e: unknown): Result {
	if (e instanceof UsageError)
		return { command, exit_code: 2, error: { code: "usage", message: e.message }, next_step: HELP_NEXT, textErr: [e.message, USAGE] };
	if (e instanceof RouteMissingError)
		return {
			command,
			exit_code: 4,
			error: { code: "route_missing", message: e.message },
			next_step: "commertize-agent routes --json",
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof KitConfigError) {
		const m = e.message;
		const next = /SESSION_TOKEN/.test(m)
			? "Sign in at commertize.com and export COMMERTIZE_SESSION_TOKEN, or run: commertize-agent auth start --json"
			: /API_KEY/.test(m)
				? "Export COMMERTIZE_API_KEY with your own issued key"
				: /--allow-host|BASE_URL/.test(m)
					? "Unset COMMERTIZE_API_BASE_URL, or pass --allow-host with the exact host you trust"
					: HELP_NEXT;
		return { command, exit_code: 1, error: { code: "config", message: m }, next_step: next, textErr: [`commertize-agent: ${m}`] };
	}
	if (e instanceof ApiError)
		return {
			command,
			exit_code: 1,
			error: { code: "api", message: e.message, status: e.status },
			next_step: "commertize-agent routes --json",
			textErr: [`commertize-agent: ${e.message}`],
		};
	const m = (e as Error)?.message ?? String(e);
	return { command, exit_code: 1, error: { code: "internal", message: m }, next_step: null, textErr: [`commertize-agent: ${m}`] };
}

export interface Deps {
	/** Builds the API client. Library seam for tests and embedding; not reachable from argv or the environment. */
	client?: (allowHost: string | undefined, warn: Out) => CommertizeClient;
	/** Where an approved sign-in's credential goes. Unset: it is not kept (and never printed). */
	credentialSink?: CredentialSink;
	/** The OS keychain. Only bin.ts wires the real one; the library and tests default to none. */
	keychain?: Keychain;
	readStdin?: () => Promise<string>;
	/** Stream seams (tests): sleep, a poll cap, and the HTTP listener for serve. */
	sleep?: (ms: number) => Promise<void>;
	maxPolls?: number;
	listenServer?: ListenServer;
	/** false: do not install SIGINT/SIGTERM handlers (tests). */
	signals?: boolean;
	/** Set by main from --json; streams print NDJSON when true. */
	json?: boolean;
}

export type ListenServer = (
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	port: number,
	host: string
) => Promise<{ close: () => Promise<void> }>;

const defaultListen: ListenServer = (handler, port, host) =>
	new Promise((resolve, reject) => {
		const s = createServer(handler);
		s.once("error", reject);
		s.listen({ port, host, exclusive: true }, () =>
			resolve({ close: () => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r()))) })
		);
	});

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * audit L-2: board values are untrusted. In human text mode, C0/C1 controls (ESC, CR, LF), DEL,
 * U+2028/2029 and bidi/format overrides become "?", and each value is cut to 128 characters, so a
 * hostile row cannot fake a line or an escape sequence. --json is unchanged (JSON.stringify escapes).
 */
export function textSafe(v: unknown): string {
	const cps = Array.from(String(v), (ch) => (unsafeCodePoint(ch.codePointAt(0)!) ? "?" : ch));
	return cps.length > 128 ? cps.slice(0, 128).join("") + "..." : cps.join("");
}

/** C0 controls, DEL and C1 controls, zero-width marks, U+2028/2029 and bidi embeddings/overrides/isolates, BOM. */
function unsafeCodePoint(c: number): boolean {
	return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
}

function textEvent(e: KitEvent): string {
	const d = e.data;
	const id = typeof d.task_id === "string" ? ` ${textSafe(d.task_id)}` : "";
	const st = typeof d.status === "string" ? ` ${d.previous_status ? `${textSafe(d.previous_status)} -> ` : ""}${textSafe(d.status)}` : "";
	const extra = e.type === "work.board.snapshot" ? ` ${textSafe(d.count)} task(s)` : e.type === "stream.error" ? ` ${textSafe(d.message)}` : "";
	return `${textSafe(e.ts)} ${e.type}${id}${st}${extra}`;
}

/** Public status words: "Live" and "Not open" (present-tense facts only). */
export function routeLabel(r: { status: string }): "Live" | "Not open" {
	return r.status === "live" ? "Live" : "Not open";
}

/** Environment first; the keychain fills only a credential the environment does not set. */
export function clientFromEnv(allowHost: string | undefined, warn: Out, kc?: Keychain, fetchImpl?: typeof fetch): CommertizeClient {
	const env = readEnv(process.env, allowHost, warn);
	if (kc && kc.available()) {
		if (!env.sessionToken) env.sessionToken = kc.get("COMMERTIZE_SESSION_TOKEN");
		if (!env.apiKey) env.apiKey = kc.get("COMMERTIZE_API_KEY");
	}
	return new CommertizeClient(env, fetchImpl);
}

const STDIN_MAX = 16 * 1024;
async function readAllStdin(): Promise<string> {
	if (process.stdin.isTTY) throw new KitConfigError("pipe the credential on stdin (it is never read from argv)");
	let s = "";
	for await (const c of process.stdin) {
		s += c;
		if (s.length > STDIN_MAX) throw new KitConfigError("stdin too large for a credential; nothing stored");
	}
	return s;
}

/** SKILL.md next to the package root (src/ when run from source, dist/ when installed). */
function skillPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "SKILL.md");
}

function startResult(command: string, s: AuthStartResult, exit: number): Result {
	return {
		command,
		exit_code: exit,
		data: s,
		next_step: `commertize-agent auth complete --request ${s.requestId} --wait --json`,
		text: [`Open this link to sign in (expires in ${s.expiresIn} s):`, s.signinUrl, `Then run: commertize-agent auth complete --request ${s.requestId} --wait`],
	};
}

async function dispatch(cmd: string | undefined, rest: string[], out: Out, err: Out, deps: Deps): Promise<Result> {
	const mkClient = deps.client ?? ((allowHost: string | undefined, warn: Out) => clientFromEnv(allowHost, warn, deps.keychain));
	const kc = deps.keychain;
	const sink: CredentialSink | undefined =
		deps.credentialSink ??
		(kc && kc.available()
			? async (tok) => (kc.set("COMMERTIZE_SESSION_TOKEN", tok), { stored: true, where: `OS keychain (${KEYCHAIN_SERVICE})` })
			: undefined);
	if (cmd === "configure") {
		const { values } = parse(rest, {
			"session-token-stdin": { type: "boolean" },
			"api-key-stdin": { type: "boolean" },
			clear: { type: "string" },
		});
		const modes = [values["session-token-stdin"], values["api-key-stdin"], values.clear !== undefined].filter(Boolean).length;
		if (modes > 1) throw new UsageError("configure takes one of --session-token-stdin, --api-key-stdin, --clear NAME");
		const envNext = "Use the environment instead: export COMMERTIZE_SESSION_TOKEN / COMMERTIZE_API_KEY in your own shell";
		if (!kc || !kc.available()) {
			if (modes === 0)
				return { command: cmd, exit_code: 0, data: { keychain_available: false, stored: {} }, next_step: envNext, text: ["No supported OS keychain here (macOS only). " + envNext] };
			return { command: cmd, exit_code: 1, error: { code: "config", message: "no supported OS keychain here (macOS only); nothing stored" }, next_step: envNext, textErr: ["commertize-agent: no supported OS keychain here; nothing stored"] };
		}
		let action: string | null = null;
		if (values.clear !== undefined) {
			const n = checkName(values.clear as string);
			action = kc.clear(n) ? `cleared ${n}` : `${n} was not stored`;
		} else if (values["session-token-stdin"] || values["api-key-stdin"]) {
			const n: KeyName = values["api-key-stdin"] ? "COMMERTIZE_API_KEY" : "COMMERTIZE_SESSION_TOKEN";
			const read = deps.readStdin ?? readAllStdin;
			const v = (await read()).trim();
			if (!v) throw new KitConfigError(`nothing on stdin for ${n}; nothing stored`);
			kc.set(n, v);
			action = `stored ${n}`;
		}
		const stored = Object.fromEntries(KEY_NAMES.map((n) => [n, kc.has(n)]));
		return {
			command: cmd,
			exit_code: 0,
			data: { keychain_available: true, service: KEYCHAIN_SERVICE, stored, action },
			next_step: stored.COMMERTIZE_SESSION_TOKEN || stored.COMMERTIZE_API_KEY ? "commertize-agent routes --json" : "commertize-agent auth start --json",
			text: [
				...(action ? [`configure: ${action}`] : []),
				...KEY_NAMES.map((n) => `${n.padEnd(26)} ${stored[n] ? "stored in the OS keychain" : "not stored"}`),
			],
		};
	}
	if (cmd === undefined || cmd === "help") {
		parse(rest, {});
		return { command: "help", exit_code: 0, data: { version: KIT_VERSION, commands: [...COMMANDS], templates: [...TEMPLATES] }, next_step: "commertize-agent routes --json", text: [USAGE] };
	}
	if (cmd === "skill") {
		const { positionals } = parse(rest, {}, true);
		if (positionals.length !== 1 || positionals[0] !== "print") throw new UsageError("skill needs exactly: print");
		const t = readFileSync(skillPath(), "utf8");
		return {
			command: cmd,
			exit_code: 0,
			data: { text: t, sha256: createHash("sha256").update(t).digest("hex") },
			next_step: "commertize-agent routes --json",
			text: [t.endsWith("\n") ? t.slice(0, -1) : t],
		};
	}
	if (cmd === "version") {
		parse(rest, {});
		return { command: cmd, exit_code: 0, data: { version: KIT_VERSION }, next_step: null, text: [KIT_VERSION] };
	}
	if (cmd === "init") {
		const { positionals } = parse(rest, {}, true);
		const [name, dir] = positionals;
		if (!name) throw new UsageError("init needs a template name");
		const target = dir ?? name;
		const files = init(name, target, KIT_VERSION);
		return {
			command: cmd,
			exit_code: 0,
			data: { dir: target, template: name, files },
			next_step: `Wire your model in ${target}/model.ts, then: cd ${target} && npm install && npm start`,
			text: [`Created ${target}: ${files.join(", ")}\nNext: wire your model in model.ts, then npm install && npm start.`],
		};
	}
	if (cmd === "auth") {
		const [sub, ...more] = rest;
		if (sub === "start") {
			const { values } = parse(more, { "allow-host": { type: "string" }, "no-wait": { type: "boolean" } });
			return startResult("auth", await authStart(mkClient(values["allow-host"] as string | undefined, err)), AUTH_EXIT.approved);
		}
		if (sub === "complete") {
			const { values } = parse(more, {
				request: { type: "string" },
				wait: { type: "boolean" },
				"no-wait": { type: "boolean" },
				timeout: { type: "string" },
				"allow-host": { type: "string" },
			});
			const id = values.request as string | undefined;
			if (!id) throw new UsageError("auth complete needs --request <id>");
			try {
				checkRequestId(id);
			} catch (e) {
				throw new UsageError((e as Error).message);
			}
			if (values.wait && values["no-wait"]) throw new UsageError("--wait and --no-wait together");
			let timeoutMs: number | undefined;
			if (values.timeout !== undefined) {
				const s = Number(values.timeout);
				if (!Number.isInteger(s) || s < 1 || s > 1800) throw new UsageError("--timeout is whole seconds, 1-1800");
				timeoutMs = s * 1000;
			}
			const r = await authComplete(mkClient(values["allow-host"] as string | undefined, err), id, {
				wait: values.wait === true,
				timeoutMs,
				onCredential: sink,
			});
			const next =
				r.status === "approved"
					? r.credential === "not_stored"
						? "Approved, but no credential store is set up, so the credential was not kept. Run: commertize-agent configure --json, then auth start again"
						: null
					: r.status === "pending" || r.status === "timeout"
						? `commertize-agent auth complete --request ${id} --wait --json`
						: "commertize-agent auth start --json";
			return {
				command: "auth",
				exit_code: AUTH_EXIT[r.status],
				data: r,
				next_step: next,
				text: [`Sign-in ${r.status}${r.credential === "stored" ? ` (credential kept in ${r.where})` : r.credential === "not_stored" ? " (credential NOT kept: no store configured)" : ""}`],
			};
		}
		throw new UsageError("auth needs start or complete");
	}
	if (cmd === "events" || cmd === "job" || cmd === "serve") {
		const sub = cmd === "serve" ? "serve" : rest[0];
		const more = cmd === "serve" ? rest : rest.slice(1);
		if (cmd === "job" && sub === "history") {
			const { values, positionals } = parse(more, { from: { type: "string" } }, true);
			const [taskId] = positionals;
			if (!taskId || !values.from) throw new UsageError("job history needs <taskId> --from <events.ndjson>");
			const h = history(values.from as string, taskId);
			return {
				command: "job",
				exit_code: 0,
				data: { task_id: taskId, events: h.events, skipped_lines: h.skipped },
				next_step: h.events.length ? null : `No events for ${taskId} in that file; record some with: commertize-agent events listen --json >> events.ndjson`,
				text: h.events.map(textEvent).concat(h.skipped ? [`(${h.skipped} line(s) were not kit events and were skipped)`] : []),
			};
		}
		const isListen = cmd === "events" && sub === "listen";
		const isWatch = cmd === "job" && sub === "watch";
		if (!isListen && !isWatch && cmd !== "serve") throw new UsageError(`${cmd} needs ${cmd === "events" ? "listen" : "watch or history"}`);
		const { values, positionals } = parse(
			more,
			{
				interval: { type: "string" },
				once: { type: "boolean" },
				"allow-host": { type: "string" },
				...(cmd === "serve" ? { port: { type: "string" } } : {}),
			},
			isWatch
		);
		const taskId = isWatch ? positionals[0] : undefined;
		if (isWatch && !taskId) throw new UsageError("job watch needs <taskId>");
		let intervalMs: number | undefined;
		if (values.interval !== undefined) {
			const s = Number(values.interval);
			if (!Number.isInteger(s) || s < POLL_FLOOR_MS / 1000 || s > 3600) throw new UsageError(`--interval is whole seconds, ${POLL_FLOOR_MS / 1000}-3600`);
			intervalMs = s * 1000;
		}
		let port = 0;
		if (cmd === "serve") {
			port = Number(values.port ?? "8787");
			if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UsageError("--port is 1024-65535");
		}
		const client = mkClient(values["allow-host"] as string | undefined, err);
		const ac = new AbortController();
		const onSig = () => ac.abort();
		if (deps.signals !== false) {
			process.once("SIGINT", onSig);
			process.once("SIGTERM", onSig);
		}
		const hub = new EventHub();
		let server: { close: () => Promise<void> } | undefined;
		try {
			if (cmd === "serve") {
				const listenFn = deps.listenServer ?? defaultListen;
				server = await listenFn(makeHandler(hub, port, () => ({ port })), port, SERVE_HOST);
				err(`commertize-agent: serving events on http://${SERVE_HOST}:${port}/events (loopback only)`);
			}
			const emit = (e: KitEvent) => {
				if (cmd === "serve") hub.publish(e);
				else if (deps.json) out(JSON.stringify(e));
				else out(textEvent(e));
			};
			const o = await listen({
				client,
				emit,
				intervalMs,
				taskId,
				stopWhen: taskId ? watchStop(taskId) : undefined,
				maxPolls: values.once ? 1 : deps.maxPolls,
				sleep: deps.sleep ? deps.sleep : (ms) => abortableSleep(ms, ac.signal),
				signal: ac.signal,
			});
			const command = cmd === "serve" ? "serve" : cmd;
			if (o.reason === "route_missing")
				return { command, exit_code: 4, data: o, error: { code: "route_missing", message: o.message ?? "" }, next_step: "commertize-agent routes --json" };
			return {
				command,
				exit_code: 0,
				data: o,
				next_step: isWatch && o.reason === "stopped" ? `commertize-agent job history ${taskId} --from <file you recorded>` : null,
			};
		} finally {
			process.removeListener("SIGINT", onSig);
			process.removeListener("SIGTERM", onSig);
			hub.closeAll();
			if (server) await server.close();
		}
	}
	if (cmd === "register") {
		const { values } = parse(rest, {
			"agent-address": { type: "string" },
			"task-class": { type: "string", multiple: true },
			"allow-host": { type: "string" },
			"no-wait": { type: "boolean" },
		});
		const addr = values["agent-address"] as string | undefined;
		if (!addr) throw new UsageError("register needs --agent-address 0x...");
		const client = mkClient(values["allow-host"] as string | undefined, err);
		if (values["no-wait"] && !client.env.sessionToken) {
			if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new KitConfigError("--agent-address must be a 0x-prefixed 20-byte address");
			return startResult("register", await authStart(client, { agentAddress: addr }), AUTH_EXIT.pending);
		}
		const r = await register(client, addr, (values["task-class"] as string[] | undefined) ?? []);
		return {
			command: cmd,
			exit_code: 3, // registered; the mandate route is Not open
			data: r,
			next_step: "The task mandate route is Not open; check `commertize-agent routes --json` for taskMandateCreate",
			text: [
				[
					`Wallet: ${r.passport.agentAddress} (${r.passport.reused ? "already registered" : "registered"}, ${r.passport.passportId})`,
					`Mandate: not set. ${r.mandate.reason}`,
					`Work: ${r.taskNote}`,
				].join("\n"),
			],
		};
	}
	if (cmd === "routes") {
		parse(rest, {});
		const rows = Object.values(ROUTES) as (typeof ROUTES)[keyof typeof ROUTES][];
		return {
			command: cmd,
			exit_code: 0,
			data: { checked_at: ROUTES_CHECKED_AT.date, routes: rows.map((r) => ({ ...r, label: routeLabel(r) })) },
			next_step: null,
			text: [
				`Route status as of ${ROUTES_CHECKED_AT.date}`,
				...rows.map(
					(r) =>
						`${routeLabel(r).padEnd(8)} ${r.method.padEnd(4)} ${r.path}${"switchable" in r ? "  [answers 404 while switched off]" : ""}${
							"pending" in r && r.pending !== "Not open" ? `  (${r.pending})` : ""
						}`
				),
			],
		};
	}
	if (cmd === "mcp") {
		const { values, positionals } = parse(rest, { server: { type: "string" } }, true);
		const [name] = positionals;
		const server = values.server as string | undefined;
		if (!name || !server) throw new UsageError("mcp needs <template> and --server /abs/path/dist/index.js");
		const { config, tools } = mcpClientConfig(name, server);
		return {
			command: cmd,
			exit_code: 0,
			data: { config, tools, checked_at: MCP_TOOLS_CHECKED_AT.date },
			next_step: "Add the config to your MCP client; open a gate on your own machine only if you decide to",
			text: [JSON.stringify(config, null, "\t")],
			textErr: [
				`Server tools for ${name} (as of ${MCP_TOOLS_CHECKED_AT.date}). The server lists a gated tool only when its variable is exactly "1"; this config sets none:`,
				...tools.map(
					(t) => `  ${t.name.padEnd(22)} ${t.gate ?? "no gate"}${t.availability === "in-review" ? "  (in review on the server, not on its main branch)" : ""}`
				),
			],
		};
	}
	throw new UsageError(`unknown command "${cmd}"`);
}

export function render(r: Result, json: boolean, out: Out, err: Out): number {
	if (json) {
		out(
			JSON.stringify({
				schema: JSON_SCHEMA,
				command: r.command,
				ok: r.exit_code === 0,
				exit_code: r.exit_code,
				data: r.data ?? null,
				error: r.error ?? null,
				next_step: r.next_step,
			})
		);
	} else {
		for (const l of r.text ?? []) out(l);
		for (const l of r.textErr ?? []) err(l);
	}
	return r.exit_code;
}

export async function main(argv: string[], out: Out = console.log, err: Out = console.error, deps: Deps = {}): Promise<number> {
	const { json, rest: args } = takeJsonFlag(argv);
	const [cmd, ...rest] = args;
	let r: Result;
	try {
		r = await dispatch(cmd, rest, out, err, { ...deps, json });
	} catch (e) {
		r = errorResult(cmd ?? "help", e);
	}
	return render(r, json, out, err);
}
