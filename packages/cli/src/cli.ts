#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { ApiError, CommertizeClient, KitConfigError, readEnv } from "./client.ts";
import { AUTH_EXIT, authComplete, authStart, checkRequestId, type AuthStartResult, type CredentialSink } from "./auth.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_TYPES, history, listen, matchesFilter, POLL_FLOOR_MS, watchStop, type EventFilter, type KitEvent } from "./events.ts";
import { EventHub, makeHandler, SERVE_HOST } from "./serve.ts";
import { drain, DrainBusyError, DrainSourceChangedError, DrainUsageError, DRAIN_LIMIT_MAX } from "./drain.ts";
import { EXIT, handBack, notOpen, taskFinal, type HandBack, type Reason } from "./handback.ts";
import { AgentTextError, checkAgentFields } from "./agenttext.ts";
import { AGENTS_PAGE_MAX, listAgents, mandateShow, NotFoundError, UnexpectedAnswerError, UUID, whoami, type CredentialSource } from "./whoami.ts";
import { skillCheck } from "./skillcheck.ts";
import { findAgent, identityShow } from "./identity.ts";
import { checkProfileName, readActiveAgent, writeActiveAgent, type ActiveAgent } from "./profile.ts";
import { balance, isNetwork, NETWORKS, TOKENS, type Token } from "./chain.ts";
import { signerInit, signerStatus, SignerExistsError, SignerNotOpenError } from "./signer.ts";
import { ATTEST_DOMAIN, checkAttestPayload, NotAllowlistedError } from "./attest.ts";
import { mandateRevoke } from "./mandate.ts";
import { AgentKeyExistsError, agentKeyStatus, classifyTypedData, importAgentKey, readTypedDataFile } from "./agentkey.ts";
import { agentKeyReceiptLog, assertNotDisabled, disableSigning, DisabledError, enableSigning, ensureDefaultDisabled, receiptDigest } from "./receiptsigner.ts";
import { recoverAddress } from "./secp256k1.ts";
import { homedir } from "node:os";

/** No agent was named and no profile has one set. */
class NoActiveAgentError extends Error {
	constructor() {
		super("no agent named and no active agent set for this profile");
		this.name = "NoActiveAgentError";
	}
}
import { checkName, KEY_NAMES, KEYCHAIN_NAMES, KEYCHAIN_SERVICE, type KeyName, type Keychain } from "./keychain.ts";
import { init, TEMPLATES } from "./init.ts";
import { MCP_TOOLS_CHECKED_AT, mcpClientConfig } from "./mcp.ts";
import { register } from "./register.ts";
import { ROUTES, ROUTES_CHECKED_AT, RouteMissingError } from "./routes.ts";
import { assertServeEnabled, parseServeConfig, ServeConfigError } from "./seller.ts";

export const KIT_VERSION = "0.2.0";

/** Every `--json` result carries this schema id. */
export const JSON_SCHEMA = "commertize.agent-kit.cli.v1";

/**
 * `serve` is reserved for serving your own handler as a paid endpoint (docs/serve-paid-endpoint.md).
 * It is Not open in this release and answers exit 4; the event stream is `events serve`.
 */
export const COMMANDS = [
	"help",
	"version",
	"init",
	"auth",
	"register",
	"whoami",
	"agents",
	"agent",
	"mandate",
	"signer",
	"identity",
	"wallet",
	"receipt",
	"events",
	"job",
	"serve",
	"service",
	"routes",
	"mcp",
	"skill",
	"configure",
] as const;

const USAGE = `commertize-agent ${KIT_VERSION}

  commertize-agent init <template> [dir]     copy a template (${TEMPLATES.join(", ")})
  commertize-agent register --agent-address 0x... [--task-class c]... [--allow-host h]
                                             register your agent's wallet on Commertize and
                                             find the first open Work task
      --name <s> --description <s> --homepage https://...
                                             agent-declared text: checked locally (1-64, 1-280,
                                             https only), then Not open (exit 4), nothing sent
  commertize-agent agent update --agent <passportId> [--name] [--description] [--homepage]
                                             Not open (exit 4): checked locally, nothing sent
  commertize-agent auth start [--no-wait]    start sign-in: prints the link and a request id, exits
  commertize-agent auth complete --request <id> [--wait | --no-wait] [--timeout s]
                                             check (or wait for) that sign-in; exit 0 approved,
                                             5 pending, 6 denied, 7 expired, 8 timed out
  commertize-agent register ... --no-wait    with no session: start sign-in instead (exit 5)
  commertize-agent whoami [--agent 0x...] [--receipts <file.ndjson>]
                                             one read: your company check, your agent and its
                                             mandates, which credentials are present, receipts
  commertize-agent agents [--limit n] [--cursor id]
                                             the agents registered under your account
  commertize-agent agents --use <passportId|0x...> [--profile name] [--dry-run]
                                             make one of your active agents the one later
                                             commands act as (kept in ~/.commertize, no secret)
  commertize-agent mandate show <mandateId>  one of your mandates (read only)
  commertize-agent mandate request | request-change
                                             hand back to the person you act for: they create
                                             or change and sign the mandate (exit 5); the kit
                                             never writes or signs a mandate
  commertize-agent mandate request --caps <file> --level L1|L2 --expires <ISO time> [--agent passportId]
  commertize-agent mandate request-change --caps <file> --mandate <mandateId>
                                             check a mandate request or a cap increase request on
                                             this machine; sending it is Not open (exit 4) and
                                             nothing is sent; exit 19 if ~/.commertize/DISABLED
  commertize-agent mandate revoke <mandateId> --confirm | --dry-run
                                             end one of your mandates; the state is read back
  commertize-agent signer init | status | link
                                             a P-256 device key in the OS keychain; linking it
                                             to an agent is Not open (exit 4)
  commertize-agent identity show [--agent 0x...|passportId] [--profile name]
                                             that agent's passport, its raw kya_state code and
                                             its KYA check record (exit 4 if that record is Not open)
  commertize-agent identity credential [--agent passportId] [--verify]
                                             the passport credential: Not open (exit 4), nothing sent
  commertize-agent wallet address [--agent 0x...] [--profile name]
  commertize-agent wallet balance [--network base|base-sepolia] [--token USDC|ETH] [--agent 0x...]
                                             read-only balance on Base (no key, no signing)
  commertize-agent wallet key import --stdin | status
                                             your agent's own key, from stdin only, into the OS
                                             keychain (create-only; must match the active agent)
  commertize-agent receipt test-sign [--profile name]
                                             sign one self-test receipt with the agent key and
                                             check it recovers; exit 19 if ~/.commertize/DISABLED
  commertize-agent wallet sign-typed-data --file <typed-data.json>
                                             signs nothing in this release: the allowed list is
                                             empty (exit 4); a CAS mandate goes to the person
  commertize-agent events listen [--interval s] [--once] [filters]
                                             Work board changes as they happen (polls, floor 15 s);
                                             with --json, one event object per line (NDJSON)
  commertize-agent events drain --file <file.ndjson> [--limit n] [--consumer name] [--key k] [filters]
                                             take the next batch from a file events listen wrote,
                                             and acknowledge it in the same step (retry: same --key)
  commertize-agent events serve [--port 8787] [filters]
                                             the event stream at http://127.0.0.1:<port>/events
                                             (loopback only, read only, no credentials)
      filters: --type <event type> (repeatable), --since <ISO time>, --job <taskId>
  commertize-agent job watch <taskId>        one task's changes, until it reaches a final state
                                             (exit 0 completed, 10 rejected, 11 expired,
                                             12 cancelled, 13 closed, 14 left the board)
  commertize-agent job history <taskId> --from <file.ndjson>
                                             that task's events from a file events listen wrote
  commertize-agent serve                     reserved: serving your own handler as a paid
                                             endpoint is Not open (exit 4); see events serve
  commertize-agent serve start [--config commertize.serve.json]
                                             checks the serve kill file and your config on this
                                             machine, then Not open (exit 4): nothing bound or sent
  commertize-agent service publish [--config commertize.serve.json]
                                             checks the kill file and your config on this machine,
                                             then Not open (exit 4): nothing sent. unpublish and
                                             show are Not open (exit 4)
  commertize-agent routes                    every route the kit calls, live or not open
  commertize-agent mcp <template> --server /abs/path/mcp-server/dist/index.js
                                             MCP client config for a template, and the server
                                             tools and gates it uses (opens no gate)
  commertize-agent configure [--session-token-stdin | --api-key-stdin | --clear NAME]
                                             keep your credentials in the OS keychain (macOS);
                                             values are read from stdin only, never printed
  commertize-agent skill print               the operating guide for a coding agent (SKILL.md)
  commertize-agent skill check --path <file> is that installed copy this release's guide?
                                             (exit 15 when any copy differs or is missing)
  commertize-agent version | help

  --json  on any command: print exactly one JSON object per result on stdout
          ({ schema, command, ok, exit_code, data, error, next_step, hand_back })
          hand_back { reason, by, url } is set on every refusal and every final state

Environment (read, never stored): COMMERTIZE_API_BASE_URL, COMMERTIZE_SESSION_TOKEN, COMMERTIZE_API_KEY
`;
/** The help text, as shipped (tests lint it). */
export const USAGE_TEXT = USAGE;

const HELP_NEXT = "commertize-agent help --json";

/** The NOT_OPEN refusal (apx-b58b04e86a) as a result: exit 4, route_not_open, before any client is built. */
function notOpenResult(command: string, what: string): Result {
	const message = notOpen(what);
	return {
		command,
		exit_code: EXIT.not_open,
		error: { code: "not_open", message },
		next_step: "commertize-agent routes --json",
		hand_back: handBack("route_not_open"),
		textErr: [message],
	};
}

export type Out = (line: string) => void;

/** What every command returns. Text and JSON output are both rendered from this. */
export interface Result {
	command: string;
	exit_code: number;
	data?: unknown;
	error?: {
		code: "usage" | "config" | "route_missing" | "not_open" | "api" | "internal" | "timeout" | "denied" | "expired" | "busy" | "source_changed" | "not_found" | "drift" | "TYPED_DATA_NOT_ALLOWLISTED";
		message: string;
		status?: number;
	};
	/** One instruction for the caller (a command line or a sentence), or null when there is nothing left to do. */
	next_step: string | null;
	/** Set on every refusal and every final state (see handback.ts). render() fills one in for any non-zero exit that lacks it. */
	hand_back?: HandBack | null;
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

const FILTER_FLAGS = {
	type: { type: "string", multiple: true },
	since: { type: "string" },
	job: { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** --type / --since / --job, validated. An unknown event type or an unreadable time is a usage error, never ignored. */
function filterFrom(values: Values): EventFilter | undefined {
	const f: EventFilter = {};
	const types = values.type as string[] | undefined;
	if (types?.length) {
		for (const t of types) if (!(EVENT_TYPES as readonly string[]).includes(t)) throw new UsageError(`--type must be one of: ${EVENT_TYPES.join(", ")}`);
		f.types = new Set(types);
	}
	if (values.since !== undefined) {
		const s = values.since as string;
		const ms = Date.parse(s);
		if (!ISO_TIME.test(s) || !Number.isFinite(ms)) throw new UsageError("--since is an ISO 8601 time, e.g. 2026-10-28T17:00:00Z");
		f.sinceMs = ms;
	}
	if (values.job !== undefined) {
		if (!TASK_ID.test(values.job as string)) throw new UsageError("--job is a task id (1-128 characters of A-Z a-z 0-9 _ . : -)");
		f.job = values.job as string;
	}
	return Object.keys(f).length ? f : undefined;
}

/** Where each credential comes from: the environment wins, then the keychain. Values are never read here. */
function credentialSources(kc: Keychain | undefined): { session_token: CredentialSource; api_key: CredentialSource } {
	const src = (n: KeyName): CredentialSource =>
		process.env[n]?.trim() ? "environment" : kc && kc.available() && kc.has(n) ? "keychain" : "absent";
	return { session_token: src("COMMERTIZE_SESSION_TOKEN"), api_key: src("COMMERTIZE_API_KEY") };
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

export function errorResult(command: string, e: unknown): Result {
	if (e instanceof UsageError || e instanceof DrainUsageError || e instanceof AgentTextError)
		return {
			command,
			exit_code: EXIT.usage,
			error: { code: "usage", message: e.message },
			next_step: HELP_NEXT,
			hand_back: handBack("usage"),
			textErr: [e.message, USAGE],
		};
	if (e instanceof RouteMissingError)
		return {
			command,
			exit_code: EXIT.not_open,
			error: { code: "route_missing", message: e.message },
			next_step: "commertize-agent routes --json",
			hand_back: handBack("route_not_open"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	// A refused payload is its own refusal (never labelled as a missing route). Exit 4, as every typed-data refusal (spec §8 table).
	if (e instanceof NotAllowlistedError)
		return {
			command,
			exit_code: EXIT.not_open,
			error: { code: e.code, message: e.message },
			next_step: null,
			hand_back: handBack("typed_data_not_allowlisted"),
			textErr: [`commertize-agent: not signed: ${e.message}`],
		};
	if (e instanceof SignerNotOpenError)
		return {
			command,
			exit_code: EXIT.not_open,
			error: { code: "not_open", message: e.message },
			next_step: "commertize-agent routes --json",
			hand_back: handBack("route_not_open"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof KitConfigError) {
		const m = e.message;
		const [next, reason]: [string, Reason] = /SESSION_TOKEN/.test(m)
			? ["Ask the person you act for to sign in (hand_back.url), or run: commertize-agent auth start --json", "session_missing"]
			: /API_KEY/.test(m)
				? ["Ask the person you act for to issue an API key (hand_back.url) and export COMMERTIZE_API_KEY in their own shell", "api_key_missing"]
				: /--allow-host|BASE_URL/.test(m)
					? ["Ask the person you act for which API host to trust; do not pass --allow-host on your own", "host_not_allowed"]
					: [HELP_NEXT, "config"];
		return { command, exit_code: EXIT.error, error: { code: "config", message: m }, next_step: next, hand_back: handBack(reason), textErr: [`commertize-agent: ${m}`] };
	}
	if (e instanceof ApiError)
		return {
			command,
			exit_code: EXIT.error,
			error: { code: "api", message: e.message, status: e.status },
			next_step: "commertize-agent routes --json",
			hand_back: handBack("api_error"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof DrainBusyError)
		return {
			command,
			exit_code: EXIT.busy,
			error: { code: "busy", message: e.message },
			next_step: "Retry the same events drain command (with the same --key) after a short wait. If it stays busy and no drain is running, see https://github.com/Commertize-Inc/agent-kit/blob/main/docs/agent-loop.md#a-lock-that-stays-busy",
			hand_back: handBack("busy"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof DrainSourceChangedError)
		return {
			command,
			exit_code: EXIT.error,
			error: { code: "source_changed", message: e.message },
			next_step: "Drain with a new --consumer name",
			hand_back: handBack("drain_source_changed"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof DisabledError)
		return {
			command,
			exit_code: EXIT.frozen,
			error: { code: "config", message: e.message },
			next_step: "Stop and show the person hand_back.url: signing stays off until they enable it on this machine themselves. Never enable it yourself.",
			hand_back: handBack("disabled"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof AgentKeyExistsError)
		return {
			command,
			exit_code: EXIT.error,
			error: { code: "config", message: e.message },
			next_step: "commertize-agent wallet key status --json",
			hand_back: handBack("agent_key_exists"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof SignerExistsError)
		return {
			command,
			exit_code: EXIT.error,
			error: { code: "config", message: e.message },
			next_step: "commertize-agent signer status --json",
			hand_back: handBack("signer_exists"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof NoActiveAgentError)
		return {
			command,
			exit_code: EXIT.not_found,
			error: { code: "not_found", message: e.message },
			next_step: "Pass --agent 0x..., or pick one: commertize-agent agents --json, then commertize-agent agents --use <passportId> --json",
			hand_back: handBack("no_active_agent"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof UnexpectedAnswerError)
		return {
			command,
			exit_code: EXIT.error,
			error: { code: "api", message: e.message },
			next_step: null,
			hand_back: handBack("api_error"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	if (e instanceof NotFoundError)
		return {
			command,
			exit_code: EXIT.not_found,
			error: { code: "not_found", message: e.message },
			next_step: e.what === "mandate" ? "commertize-agent whoami --json" : "commertize-agent agents --json",
			hand_back: handBack(e.what === "mandate" ? "mandate_not_found" : "agent_not_found"),
			textErr: [`commertize-agent: ${e.message}`],
		};
	const m = (e as Error)?.message ?? String(e);
	return { command, exit_code: EXIT.error, error: { code: "internal", message: m }, next_step: null, hand_back: handBack("internal"), textErr: [`commertize-agent: ${m}`] };
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
	/** Home directory for ~/.commertize (tests). Not reachable from argv or the environment. */
	home?: string;
	/** fetch for the public Base RPC reads of `wallet balance` (tests). */
	rpcFetch?: typeof fetch;
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
		hand_back: exit === EXIT.ok ? null : handBack("signin_pending"),
		text: [`Open this link to sign in (expires in ${s.expiresIn} s):`, s.signinUrl, `Then run: commertize-agent auth complete --request ${s.requestId} --wait`],
	};
}

async function dispatch(cmd: string | undefined, rest: string[], out: Out, err: Out, deps: Deps): Promise<Result> {
	const mkClient = deps.client ?? ((allowHost: string | undefined, warn: Out) => clientFromEnv(allowHost, warn, deps.keychain));
	const kc = deps.keychain;
	const home = deps.home ?? homedir();
	const profileName = (values: Values): string => {
		const p = (values.profile as string | undefined) ?? "default";
		try {
			return checkProfileName(p);
		} catch (e) {
			throw new UsageError((e as Error).message);
		}
	};
	const activeAgent = (values: Values): ActiveAgent | null => readActiveAgent(home, profileName(values));
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
			confirm: { type: "boolean" },
		});
		if (values.confirm !== undefined && values.clear === undefined) throw new UsageError("--confirm goes with --clear");
		// Signing is off by default: a fresh machine gets the kill file the first time the kit is configured.
		ensureDefaultDisabled(home);
		let signing: "on" | "off";
		try {
			assertNotDisabled(home);
			signing = "on";
		} catch {
			signing = "off";
		}
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
			// A key item cannot be recreated from anywhere (it was generated here or imported once): removing it needs --confirm.
			if (!(KEY_NAMES as readonly string[]).includes(n) && values.confirm !== true)
				throw new UsageError(`${n} is a key: removing it cannot be undone here; pass --confirm to remove it`);
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
		// Key items (never their values): whether each is stored.
		const keyNames = KEYCHAIN_NAMES.filter((n) => !(KEY_NAMES as readonly string[]).includes(n));
		const keys = Object.fromEntries(keyNames.map((n) => [n, kc.has(n)]));
		return {
			command: cmd,
			exit_code: 0,
			data: { keychain_available: true, service: KEYCHAIN_SERVICE, stored, keys, action, signing },
			next_step: stored.COMMERTIZE_SESSION_TOKEN || stored.COMMERTIZE_API_KEY ? "commertize-agent routes --json" : "commertize-agent auth start --json",
			text: [
				...(action ? [`configure: ${action}`] : []),
				...KEY_NAMES.map((n) => `${n.padEnd(26)} ${stored[n] ? "stored in the OS keychain" : "not stored"}`),
				...keyNames.map((n) => `${n.padEnd(26)} ${keys[n] ? "key stored in the OS keychain (value never shown)" : "no key stored"}`),
			],
		};
	}
	if (cmd === undefined || cmd === "help") {
		parse(rest, {});
		return { command: "help", exit_code: 0, data: { version: KIT_VERSION, commands: [...COMMANDS], templates: [...TEMPLATES] }, next_step: "commertize-agent routes --json", text: [USAGE] };
	}
	if (cmd === "skill") {
		const { values, positionals } = parse(rest, { path: { type: "string", multiple: true } }, true);
		if (positionals.length === 1 && positionals[0] === "check") {
			const paths = (values.path as string[] | undefined) ?? [];
			if (!paths.length) throw new UsageError("skill check needs --path <installed SKILL.md> (repeatable)");
			const r = skillCheck(readFileSync(skillPath()), paths);
			const drifted = r.files.filter((f) => !f.upToDate);
			return {
				command: cmd,
				exit_code: r.upToDate ? EXIT.ok : EXIT.skill_drift,
				data: { version: KIT_VERSION, skillHash: r.skillHash, upToDate: r.upToDate, files: r.files },
				...(r.upToDate ? {} : { error: { code: "drift" as const, message: `${drifted.length} installed cop${drifted.length === 1 ? "y differs" : "ies differ"} from this release's guide` } }),
				next_step: r.upToDate ? null : "Replace each listed file with the output of: commertize-agent skill print",
				hand_back: r.upToDate ? null : handBack("skill_drift"),
				text: r.files.map((f) => `${f.upToDate ? "current" : "DRIFT  "} ${textSafe(f.path)}${f.problem ? ` (${textSafe(f.problem)})` : ""}`),
			};
		}
		if (values.path !== undefined) throw new UsageError("--path goes with skill check");
		if (positionals.length !== 1 || positionals[0] !== "print") throw new UsageError("skill needs exactly: print, or check --path <file>");
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
			const hb: Reason | null =
				r.status === "approved"
					? r.credential === "not_stored"
						? "credential_not_stored"
						: null
					: r.status === "pending"
						? "signin_pending"
						: r.status === "denied"
							? "signin_denied"
							: r.status === "expired"
								? "signin_expired"
								: "signin_timeout";
			return {
				command: "auth",
				exit_code: AUTH_EXIT[r.status],
				data: r,
				next_step: next,
				hand_back: hb ? handBack(hb) : null,
				text: [`Sign-in ${r.status}${r.credential === "stored" ? ` (credential kept in ${r.where})` : r.credential === "not_stored" ? " (credential NOT kept: no store configured)" : ""}`],
			};
		}
		throw new UsageError("auth needs start or complete");
	}
	if (cmd === "serve" && rest[0] === "start") {
		// Order: kill file, then the local config, then the online steps. Nothing is bound and nothing is sent.
		const { values } = parse(rest.slice(1), { config: { type: "string" } });
		assertServeEnabled(home);
		const path = (values.config as string | undefined) ?? "commertize.serve.json";
		let raw: unknown;
		try {
			if (statSync(path).size > 65_536) throw new Error("over 64 KiB");
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new KitConfigError(`serve config ${path} could not be read: ${(e as Error).message}`);
		}
		try {
			parseServeConfig(raw);
		} catch (e) {
			if (e instanceof ServeConfigError) throw new KitConfigError(e.message);
			throw e;
		}
		// The payer sanctions screen (a Tier 0 condition) has no route on this network: refuse to start.
		throw new RouteMissingError(ROUTES.servePayerScreen);
	}
	if (cmd === "service") {
		const sub = rest[0];
		if (sub === "unpublish" || sub === "show") throw new RouteMissingError(ROUTES.directoryServicePublish);
		if (sub !== "publish") throw new UsageError("service needs publish, unpublish or show");
		// A listing is a write: the kit kill file first, then the local config, then the route (Not open).
		const { values } = parse(rest.slice(1), { config: { type: "string" } });
		assertNotDisabled(home);
		const path = (values.config as string | undefined) ?? "commertize.serve.json";
		let raw: unknown;
		try {
			if (statSync(path).size > 65_536) throw new Error("over 64 KiB");
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw new KitConfigError(`serve config ${path} could not be read: ${(e as Error).message}`);
		}
		try {
			parseServeConfig(raw);
		} catch (e) {
			if (e instanceof ServeConfigError) throw new KitConfigError(e.message);
			throw e;
		}
		throw new RouteMissingError(ROUTES.directoryServicePublish);
	}
	if (cmd === "serve") {
		// Reserved name. No flag is parsed: whatever follows, nothing is bound and nothing is sent.
		return {
			command: cmd,
			exit_code: EXIT.not_open,
			error: { code: "not_open", message: "serve (your own handler as a paid endpoint) is Not open in this release; the event stream is `events serve`" },
			next_step: "commertize-agent events serve --json",
			hand_back: handBack("serve_not_open"),
			textErr: ["commertize-agent: serve (your own handler as a paid endpoint) is Not open in this release.", "For the loopback event stream run: commertize-agent events serve"],
		};
	}
	if (cmd === "events" && rest[0] === "drain") {
		const { values } = parse(rest.slice(1), { file: { type: "string" }, limit: { type: "string" }, consumer: { type: "string" }, key: { type: "string" }, ...FILTER_FLAGS });
		if (!values.file) throw new UsageError("events drain needs --file <events.ndjson>");
		let limit: number | undefined;
		if (values.limit !== undefined) {
			limit = Number(values.limit);
			if (!Number.isInteger(limit) || limit < 1 || limit > DRAIN_LIMIT_MAX) throw new UsageError(`--limit is 1-${DRAIN_LIMIT_MAX}`);
		}
		const r = drain({
			file: values.file as string,
			limit,
			consumer: values.consumer as string | undefined,
			key: values.key as string | undefined,
			filter: filterFrom(values),
		});
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: r,
			next_step: r.more ? "Handle these events, then drain again with a new --key" : null,
			text: r.events.map(textEvent).concat(r.skipped ? [`(${r.skipped} line(s) were not kit events and were skipped)`] : []),
		};
	}
	if (cmd === "events" || cmd === "job") {
		const sub = rest[0];
		const more = rest.slice(1);
		const isServe = cmd === "events" && sub === "serve";
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
		if (!isListen && !isWatch && !isServe) throw new UsageError(`${cmd} needs ${cmd === "events" ? "listen, drain or serve" : "watch or history"}`);
		const { values, positionals } = parse(
			more,
			{
				interval: { type: "string" },
				once: { type: "boolean" },
				"allow-host": { type: "string" },
				...(isServe ? { port: { type: "string" } } : {}),
				...(isWatch ? {} : FILTER_FLAGS),
			},
			isWatch
		);
		const filter = isWatch ? undefined : filterFrom(values);
		const taskId = isWatch ? positionals[0] : filter?.job;
		if (isWatch && !taskId) throw new UsageError("job watch needs <taskId>");
		let intervalMs: number | undefined;
		if (values.interval !== undefined) {
			const s = Number(values.interval);
			if (!Number.isInteger(s) || s < POLL_FLOOR_MS / 1000 || s > 3600) throw new UsageError(`--interval is whole seconds, ${POLL_FLOOR_MS / 1000}-3600`);
			intervalMs = s * 1000;
		}
		let port = 0;
		if (isServe) {
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
			if (isServe) {
				const listenFn = deps.listenServer ?? defaultListen;
				server = await listenFn(makeHandler(hub, port, () => ({ port })), port, SERVE_HOST);
				err(`commertize-agent: serving events on http://${SERVE_HOST}:${port}/events (loopback only)`);
			}
			const emit = (e: KitEvent) => {
				if (!matchesFilter(e, filter)) return;
				if (isServe) hub.publish(e);
				else if (deps.json) out(JSON.stringify(e));
				else out(textEvent(e));
			};
			const o = await listen({
				client,
				emit,
				intervalMs,
				taskId,
				stopWhen: isWatch && taskId ? watchStop(taskId) : undefined,
				maxPolls: values.once ? 1 : deps.maxPolls,
				sleep: deps.sleep ? deps.sleep : (ms) => abortableSleep(ms, ac.signal),
				signal: ac.signal,
			});
			const command = cmd;
			if (o.reason === "route_missing")
				return {
					command,
					exit_code: EXIT.not_open,
					data: o,
					error: { code: "route_missing", message: o.message ?? "" },
					next_step: "commertize-agent routes --json",
					hand_back: handBack("route_not_open"),
				};
			if (o.reason === "aborted") return { command, exit_code: EXIT.aborted, data: o, next_step: null, hand_back: handBack("aborted") };
			if (isWatch) {
				// A watch ends on a final state (its own exit code), on removal (14), or early (--once: 5, still open).
				const fin = o.final;
				const f = fin ? taskFinal(fin.status) : undefined;
				const [exit, reason]: [number, Reason] = !fin
					? [EXIT.pending, "stream_stopped"]
					: fin.status === "removed"
						? [EXIT.task_removed, "task_removed"]
						: f
							? [f.exit, f.reason]
							: [EXIT.pending, "stream_stopped"];
				return {
					command,
					exit_code: exit,
					data: o,
					next_step: fin ? `commertize-agent job history ${taskId} --from <file you recorded>` : `commertize-agent job watch ${taskId} --json`,
					hand_back: handBack(reason),
				};
			}
			return { command, exit_code: EXIT.ok, data: o, next_step: null, hand_back: handBack("stream_stopped") };
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
			name: { type: "string" },
			description: { type: "string" },
			homepage: { type: "string" },
		});
		const addr = values["agent-address"] as string | undefined;
		if (!addr) throw new UsageError("register needs --agent-address 0x...");
		// Agent-declared text has no server route on this network. It is checked locally, then refused
		// before any client or request: never dropped silently into a nameless passport.
		if (Object.keys(checkAgentFields(values)).length > 0) return notOpenResult(cmd, "register --name, --description and --homepage");
		const client = mkClient(values["allow-host"] as string | undefined, err);
		if (values["no-wait"] && !client.env.sessionToken) {
			if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new KitConfigError("--agent-address must be a 0x-prefixed 20-byte address");
			return startResult("register", await authStart(client, { agentAddress: addr }), AUTH_EXIT.pending);
		}
		const r = await register(client, addr, (values["task-class"] as string[] | undefined) ?? []);
		return {
			command: cmd,
			exit_code: EXIT.registered_mandate_not_open,
			data: r,
			next_step: "The task mandate route is Not open; check `commertize-agent routes --json` for taskMandateCreate",
			hand_back: handBack("mandate_not_open"),
			text: [
				[
					`Wallet: ${r.passport.agentAddress} (${r.passport.reused ? "already registered" : "registered"}, ${r.passport.passportId})`,
					`Mandate: not set. ${r.mandate.reason}`,
					`Work: ${r.taskNote}`,
				].join("\n"),
			],
		};
	}
	if (cmd === "whoami") {
		const { values } = parse(rest, { agent: { type: "string" }, receipts: { type: "string" }, profile: { type: "string" }, "allow-host": { type: "string" } });
		const active = activeAgent(values);
		const client = mkClient(values["allow-host"] as string | undefined, err);
		const w = await whoami(client, {
			agentAddress: (values.agent as string | undefined) ?? active?.agentAddress,
			receiptsFile: values.receipts as string | undefined,
			credentials: credentialSources(kc),
		});
		const a = w.agent;
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: w,
			next_step: a ? null : w.agents_count ? "Several agents: pass --agent 0x... to pick yours, or run: commertize-agent agents --json" : null,
			text: [
				`Company check: ${w.principal.kyb.label ?? "no label"}${w.principal.kyb.as_of ? ` (as of ${textSafe(w.principal.kyb.as_of)})` : ""}`,
				a ? `Agent: ${textSafe(a.agentAddress)} (${textSafe(a.passportId)}), kya_state ${textSafe(a.kya_state)}` : `Agents under this account: ${w.agents_count}${w.agents_truncated ? "+" : ""}`,
				`Mandates: ${w.mandates.length}`,
				"Payees: Not open",
				"Spend to date: Not open",
				"valid" in w.receipts ? `Receipts: ${w.receipts.valid} valid, ${w.receipts.invalid} not valid` : "Receipts: not counted (pass --receipts <file>)",
				`Session token: ${w.credentials.session_token}; API key: ${w.credentials.api_key}`,
			],
		};
	}
	if (cmd === "agent") {
		const { values, positionals } = parse(rest, { agent: { type: "string" }, name: { type: "string" }, description: { type: "string" }, homepage: { type: "string" } }, true);
		if (positionals.length !== 1 || positionals[0] !== "update") throw new UsageError("agent needs exactly: update --agent <passportId> and a field");
		const pid = values.agent as string | undefined;
		if (!pid || !UUID.test(pid)) throw new UsageError("agent update needs --agent <passportId>");
		if (Object.keys(checkAgentFields(values)).length === 0) throw new UsageError("agent update needs at least one of --name, --description, --homepage");
		// The passport edit route does not exist on this network: refused before any client or request.
		return notOpenResult(cmd, "agent update");
	}
	if (cmd === "agents") {
		const { values } = parse(rest, {
			limit: { type: "string" },
			cursor: { type: "string" },
			use: { type: "string" },
			profile: { type: "string" },
			"dry-run": { type: "boolean" },
			"allow-host": { type: "string" },
		});
		if (values.use !== undefined) {
			if (values.limit !== undefined || values.cursor !== undefined) throw new UsageError("--use takes no --limit or --cursor");
			const ref = values.use as string;
			if (!/^0x[0-9a-fA-F]{40}$/.test(ref) && !UUID.test(ref)) throw new UsageError("--use takes an agent's 0x address or passport id");
			const profile = profileName(values);
			const a = await findAgent(mkClient(values["allow-host"] as string | undefined, err), ref);
			// Only an active agent can be made the one later commands act as.
			if (a.kyaStatus !== "active") throw new NotFoundError("agent", `${ref} is under your account but its KYA status is ${a.kyaStatus}, not active`);
			const chosen = { passportId: a.passportId, agentAddress: a.agentAddress };
			const dry = values["dry-run"] === true;
			const w = dry ? null : writeActiveAgent(home, profile, chosen);
			return {
				command: cmd,
				exit_code: EXIT.ok,
				data: { profile, active: w?.value ?? chosen, written: !dry, path: w?.path ?? null },
				next_step: dry ? `commertize-agent agents --use ${a.passportId} --json` : "commertize-agent whoami --json",
				text: [`${dry ? "Would set" : "Set"} profile ${profile} to agent ${textSafe(a.agentAddress)} (${textSafe(a.passportId)})`],
			};
		}
		if (values["dry-run"] !== undefined || values.profile !== undefined) throw new UsageError("--dry-run and --profile go with --use");
		let limit: number | undefined;
		if (values.limit !== undefined) {
			limit = Number(values.limit);
			if (!Number.isInteger(limit) || limit < 1 || limit > AGENTS_PAGE_MAX) throw new UsageError(`--limit is 1-${AGENTS_PAGE_MAX}`);
		}
		if (values.cursor !== undefined && !UUID.test(values.cursor as string)) throw new UsageError("--cursor is an agent id from a previous page");
		const client = mkClient(values["allow-host"] as string | undefined, err);
		const r = await listAgents(client, { limit, cursor: values.cursor as string | undefined });
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: { ...r, agents: r.agents.map(({ kyaStatus, ...x }) => ({ ...x, kya_state: kyaStatus })) },
			next_step: r.next_cursor ? `commertize-agent agents --cursor ${r.next_cursor} --json` : null,
			text: (r.agents.length
				? r.agents.map((x) => `${textSafe(x.agentAddress)}  ${textSafe(x.passportId)}  kya_state ${textSafe(x.kyaStatus)}  mandates ${x.mandates.length}`)
				: ["No agents under this account."]
			).concat(r.dropped_rows ? [`(${r.dropped_rows} row(s) from the server were malformed and left out)`] : []),
		};
	}
	if (cmd === "mandate") {
		const { values, positionals } = parse(
			rest,
			{ "allow-host": { type: "string" }, confirm: { type: "boolean" }, "dry-run": { type: "boolean" }, caps: { type: "string" }, level: { type: "string" }, expires: { type: "string" }, agent: { type: "string" }, mandate: { type: "string" }, profile: { type: "string" } },
			true
		);
		const sub = positionals[0];
		if ((sub === "request" || sub === "request-change") && values.caps !== undefined) {
			// A pending request for the person to approve in the browser. Gated like every write: kill file first.
			if (positionals.length !== 1 || values.confirm !== undefined || values["dry-run"] !== undefined || values["allow-host"] !== undefined)
				throw new UsageError(`mandate ${sub} takes --caps <file>${sub === "request" ? " --level L1|L2 --expires <ISO time>" : " --mandate <mandateId>"}`);
			assertNotDisabled(home);
			const file = values.caps as string;
			if (!statSync(file).isFile()) throw new KitConfigError(`${file} is not a regular file`);
			const raw = readFileSync(file, "utf8");
			if (raw.length > 65536) throw new UsageError("--caps file is larger than 64 KiB");
			let caps: unknown;
			try {
				caps = JSON.parse(raw);
			} catch {
				throw new UsageError("--caps file is not JSON");
			}
			const nonce = randomBytes(32).toString("hex");
			let message: Record<string, unknown>;
			if (sub === "request") {
				if (values.mandate !== undefined) throw new UsageError("--mandate goes with mandate request-change");
				const passportId = (values.agent as string | undefined) ?? activeAgent(values)?.passportId;
				if (!passportId) throw new NoActiveAgentError();
				message = { passportId, level: values.level, caps, expiresAt: values.expires, nonce };
			} else {
				if (values.level !== undefined || values.expires !== undefined || values.agent !== undefined)
					throw new UsageError("mandate request-change takes --mandate <mandateId> and --caps <file> with fromCaps and toCaps");
				const c = (caps ?? {}) as Record<string, unknown>;
				message = { mandateId: values.mandate, fromCaps: c.fromCaps, toCaps: c.toCaps, nonce };
				if (typeof caps !== "object" || caps === null || Object.keys(caps).length !== 2) throw new UsageError("--caps file for request-change must have exactly fromCaps and toCaps");
			}
			const primaryType = sub === "request" ? "MandateSignatureRequest" : "CapIncreaseRequest";
			try {
				checkAttestPayload({ domain: { ...ATTEST_DOMAIN }, primaryType, message });
			} catch (e) {
				if (e instanceof NotAllowlistedError) throw new UsageError(e.message);
				throw e;
			}
			// The route that would carry the request is Not open: nothing is signed and nothing is sent.
			throw new RouteMissingError(ROUTES.mandateRequestCreate);
		}
		if (["level", "expires", "agent", "mandate", "profile"].some((k) => values[k] !== undefined))
			throw new UsageError("--level, --expires, --agent, --mandate and --profile go with mandate request --caps or request-change --caps");
		if (sub === "request" || sub === "request-change") {
			// No route carries a mandate request from an agent: the principal creates or changes it in the dashboard.
			if (positionals.length !== 1 || values.confirm !== undefined || values["dry-run"] !== undefined || values["allow-host"] !== undefined)
				throw new UsageError(`mandate ${sub} takes no arguments`);
			const reason = sub === "request" ? "mandate_request" : "mandate_change";
			const hb = handBack(reason);
			return {
				command: cmd,
				exit_code: EXIT.pending,
				data: { sent: false, by: "principal", url: hb.url },
				next_step: `Show the person ${hb.url}: they ${sub === "request" ? "create" : "change"} and sign the mandate there. Then run: commertize-agent whoami --json`,
				hand_back: hb,
				text: [`The person you act for ${sub === "request" ? "creates" : "changes"} and signs the mandate at ${hb.url}. This kit never writes or signs a mandate.`],
			};
		}
		if (sub === "revoke") {
			if (positionals.length !== 2) throw new UsageError("mandate revoke needs exactly: <mandateId> --confirm (or --dry-run)");
			if (!UUID.test(positionals[1]!)) throw new UsageError("mandate id is a UUID");
			const dry = values["dry-run"] === true;
			if (dry === (values.confirm === true)) throw new UsageError("revoking ends the mandate for good: pass --confirm, or --dry-run to see it first (not both)");
			const r = await mandateRevoke(mkClient(values["allow-host"] as string | undefined, err), positionals[1]!, dry);
			return {
				command: cmd,
				exit_code: EXIT.ok,
				data: r,
				next_step: dry && !r.already_ended ? `commertize-agent mandate revoke ${r.mandateId} --confirm --json` : null,
				text: [
					r.already_ended
						? `Mandate ${r.mandateId} had already ended (${textSafe(r.before.status)}); nothing sent.`
						: dry
							? `Mandate ${r.mandateId} is ${textSafe(r.before.status)}; --confirm would end it.`
							: `Mandate ${r.mandateId}: ${textSafe(r.before.status)} -> ${textSafe(r.after?.status)} (read back after the revoke).`,
				],
			};
		}
		if (values.confirm !== undefined || values["dry-run"] !== undefined) throw new UsageError("--confirm and --dry-run go with mandate revoke");
		if (positionals.length !== 2 || sub !== "show") throw new UsageError("mandate needs: show <mandateId>, request, request-change, or revoke <mandateId>");
		if (!UUID.test(positionals[1]!)) throw new UsageError("mandate id is a UUID");
		const client = mkClient(values["allow-host"] as string | undefined, err);
		const r = await mandateShow(client, positionals[1]!);
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: r,
			next_step: null,
			text: [JSON.stringify({ mandate: r.mandate, agent: r.agent }, (_k, v) => (typeof v === "string" ? textSafe(v) : v), "\t")],
		};
	}
	if (cmd === "signer") {
		const { positionals } = parse(rest, {}, true);
		const sub = positionals[0];
		if (positionals.length !== 1 || (sub !== "init" && sub !== "status" && sub !== "link")) throw new UsageError("signer needs exactly: init, status or link");
		// The kill file (and signing off by default) stops init and link before any key read or write.
		if (sub !== "status") assertNotDisabled(home);
		if (sub === "init") {
			const s = signerInit(kc);
			return {
				command: cmd,
				exit_code: EXIT.ok,
				data: { stored: true, where: `OS keychain (${KEYCHAIN_SERVICE})`, signer: s },
				next_step: "commertize-agent signer status --json",
				text: [`Signer key stored in the OS keychain. Fingerprint ${s.fingerprint}`, `Public key ${s.publicKey}`],
			};
		}
		const st = signerStatus(kc);
		if (sub === "link") {
			if (!st.stored) throw new KitConfigError("no signer key stored: run signer init first");
			// Binding the key to an agent needs the pairing routes; they are Not open, so this stops before any network call.
			throw new RouteMissingError(ROUTES.pairingStart);
		}
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: { ...st, link: "Not open" },
			next_step: st.stored ? null : "commertize-agent signer init --json",
			text: [st.signer ? `Signer key stored. Fingerprint ${st.signer.fingerprint}` : "No signer key stored.", "Link to an agent: Not open"],
		};
	}
	if (cmd === "identity") {
		const { values, positionals } = parse(rest, { agent: { type: "string" }, profile: { type: "string" }, "allow-host": { type: "string" }, verify: { type: "boolean" } }, true);
		if (positionals.length !== 1 || (positionals[0] !== "show" && positionals[0] !== "credential")) throw new UsageError("identity needs exactly: show, or credential");
		// The credential read route does not exist on this network: refused before any client or request.
		if (positionals[0] === "credential") return notOpenResult(cmd, "identity credential");
		if (values.verify !== undefined) throw new UsageError("--verify goes with identity credential");
		const ref = (values.agent as string | undefined) ?? activeAgent(values)?.passportId;
		if (!ref) throw new NoActiveAgentError();
		const r = await identityShow(mkClient(values["allow-host"] as string | undefined, err), ref);
		// A 404 from the check route is ambiguous (switched off, or not yours): Not open, never "no checks".
		const closed = r.checks === null;
		return {
			command: cmd,
			exit_code: closed ? EXIT.not_open : EXIT.ok,
			data: r,
			...(closed ? { error: { code: "not_open" as const, message: r.checks_note ?? "" }, hand_back: handBack("route_not_open"), next_step: "commertize-agent routes --json" } : { next_step: null }),
			text: [
				`Agent ${textSafe(r.passport.agentAddress)} (${textSafe(r.passport.passportId)}), kya_state ${textSafe(r.passport.kya_state)}`,
				r.passport.revokedAt ? `Revoked ${textSafe(r.passport.revokedAt)}` : `Created ${textSafe(r.passport.createdAt ?? "(no date)")}`,
				r.checks ? `KYA checks: ${r.checks.length}` : `KYA checks: ${r.checks_note}`,
				...(r.checks ?? []).map(
					(c) => `  ${textSafe(c.result)}  ${textSafe(c.checkId ?? "(no check id)")}  ${textSafe(c.checkedAt ?? "(no date)")}  policy ${textSafe(c.policyVersion ?? "(none)")}`
				),
			],
		};
	}
	if (cmd === "receipt") {
		const { values, positionals } = parse(rest, { profile: { type: "string" }, confirm: { type: "boolean" } }, true);
		const sub = positionals[0];
		if (positionals.length !== 1 || (sub !== "test-sign" && sub !== "enable-signing" && sub !== "disable-signing"))
			throw new UsageError("receipt needs exactly: test-sign, enable-signing --confirm, or disable-signing");
		if (sub === "disable-signing") {
			if (values.confirm !== undefined || values.profile !== undefined) throw new UsageError("disable-signing takes no flags");
			const d = disableSigning(home);
			return { command: cmd, exit_code: EXIT.ok, data: { disabled: true, ...d }, next_step: null, text: [`Signing is off (${d.path}).`] };
		}
		if (sub === "enable-signing") {
			// The person's deliberate step. An agent never runs this (SKILL.md); --confirm is required.
			if (values.confirm !== true) throw new UsageError("enable-signing turns kit signing on for this machine: the person runs it with --confirm");
			const en = enableSigning(home);
			return { command: cmd, exit_code: EXIT.ok, data: { enabled: true, killFile: en.path }, next_step: null, text: [`Signing is on for this machine. To turn it off: commertize-agent receipt disable-signing`] };
		}
		if (values.confirm !== undefined) throw new UsageError("--confirm goes with enable-signing");
		// The kill file is checked first, before the profile or the keychain is touched (and again before the signature).
		ensureDefaultDisabled(home);
		assertNotDisabled(home);
		const active = activeAgent(values);
		if (!active) err("commertize-agent: warning: no active agent is set (agents --use): receipts signed with this key cannot verify until its address is a registered agent's.");
		const log = agentKeyReceiptLog({ mandateId: "kit-self-test", agentId: active?.passportId ?? "kit-self-test" }, { keychain: kc, home });
		const r = await log.record({ verb: "check", objectRef: "kit:receipt-self-test", evidence: { purpose: "agent key self-test" } });
		const sig = r.signatures[0]!;
		const recovered = recoverAddress(receiptDigest(r.hash), Buffer.from(sig.sig, "base64url")).toLowerCase();
		const ok = recovered === sig.key_id;
		return {
			command: cmd,
			exit_code: ok ? EXIT.ok : EXIT.error,
			data: { receipt: r, recovered, matches_key_id: ok, matches_active_agent: active ? active.agentAddress.toLowerCase() === sig.key_id : null },
			...(ok ? {} : { error: { code: "internal" as const, message: "the self-test signature did not recover to its key_id" } }),
			next_step: null,
			text: [`Signed a self-test receipt as ${sig.key_id}; recovered ${recovered} (${ok ? "match" : "MISMATCH"}).`],
		};
	}
	if (cmd === "wallet" && rest[0] === "key") {
		const { values, positionals } = parse(rest.slice(1), { stdin: { type: "boolean" }, profile: { type: "string" } }, true);
		const sub = positionals[0];
		if (positionals.length !== 1 || (sub !== "import" && sub !== "status")) throw new UsageError("wallet key needs exactly: import --stdin, or status");
		if (sub === "status") {
			if (values.stdin !== undefined || values.profile !== undefined) throw new UsageError("wallet key status takes no flags");
			const s = agentKeyStatus(kc);
			return {
				command: cmd,
				exit_code: EXIT.ok,
				data: s,
				next_step: s.stored ? null : "Pipe your agent's private key: ... | commertize-agent wallet key import --stdin --json",
				text: [s.stored ? `Agent key stored for ${s.address}` : "No agent key stored."],
			};
		}
		// The key is read from stdin only: never argv (ps, shell history) and never the environment.
		if (values.stdin !== true) throw new UsageError("wallet key import reads the key from stdin only: pass --stdin and pipe it in");
		const active = activeAgent(values);
		const read = deps.readStdin ?? readAllStdin;
		const r = importAgentKey(kc, await read(), active?.agentAddress ?? null);
		err(
			"commertize-agent: warning: any process running as you can read this key from the OS keychain silently, with no prompt. Keep only a low-balance agent wallet here, never more than the mandate's operating float."
		);
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: { stored: true, where: `OS keychain (${KEYCHAIN_SERVICE})`, address: r.address, matches_active_agent: r.matched },
			next_step: r.matched === null ? `commertize-agent agents --use ${r.address} --json` : null,
			text: [`Agent key stored for ${r.address}${r.matched ? " (matches the active agent)" : ""}. The key itself is never printed.`],
		};
	}
	if (cmd === "wallet" && rest[0] === "sign-typed-data") {
		const { values, positionals } = parse(rest.slice(1), { file: { type: "string" } }, true);
		if (positionals.length || !values.file) throw new UsageError("wallet sign-typed-data needs exactly: --file <typed-data.json>");
		const c = classifyTypedData(readTypedDataFile(values.file as string));
		// The list of typed-data domains the agent key may sign is empty in this release: everything is refused, nothing is signed.
		const [reason, message]: [Reason, string] =
			c.class === "cas_mandate"
				? ["mandate_request", "a CAS mandate is signed by the person you act for, never by the agent"]
				: c.class === "permit"
					? ["payments_not_open", "a permit moves value; payments are Not open in this kit"]
					: ["typed_data_not_allowlisted", "this typed data is not on the list the agent key may sign (the list is empty in this release)"];
		return {
			command: cmd,
			exit_code: EXIT.not_open,
			data: { signed: false, class: c.class, domainName: c.domainName, primaryType: c.primaryType },
			error: { code: "not_open", message },
			next_step: c.class === "cas_mandate" ? "Show the person hand_back.url: they sign their own mandate" : null,
			hand_back: handBack(reason),
			textErr: [`commertize-agent: not signed: ${message}`],
		};
	}
	if (cmd === "wallet") {
		const { values, positionals } = parse(
			rest,
			{ agent: { type: "string" }, profile: { type: "string" }, network: { type: "string" }, token: { type: "string" } },
			true
		);
		const sub = positionals[0];
		if (positionals.length !== 1 || (sub !== "address" && sub !== "balance")) throw new UsageError("wallet needs exactly: address or balance");
		if (sub === "address" && (values.network !== undefined || values.token !== undefined)) throw new UsageError("--network and --token go with wallet balance");
		const agent = values.agent as string | undefined;
		if (agent !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(agent)) throw new UsageError("--agent is a 0x address");
		const active = agent ? null : activeAgent(values);
		const address = agent ?? active?.agentAddress;
		if (!address) throw new NoActiveAgentError();
		if (sub === "address")
			return {
				command: cmd,
				exit_code: EXIT.ok,
				data: { address, source: agent ? "flag" : "profile", passportId: active?.passportId ?? null },
				next_step: null,
				text: [address],
			};
		const network = (values.network as string | undefined) ?? "base";
		if (!isNetwork(network)) throw new UsageError(`--network is one of: ${Object.keys(NETWORKS).join(", ")}`);
		const token = ((values.token as string | undefined) ?? "USDC").toUpperCase();
		if (!(TOKENS as readonly string[]).includes(token)) throw new UsageError(`--token is one of: ${TOKENS.join(", ")}`);
		const b = await balance({ network, token: token as Token, address, fetch: deps.rpcFetch });
		return {
			command: cmd,
			exit_code: EXIT.ok,
			data: b,
			next_step: null,
			text: [`${b.formatted} ${b.token} on ${b.network} (${textSafe(b.address)})`],
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
	// Fail closed: a refusal that reached here without a hand-back still gets one.
	const hb = r.hand_back ?? (r.exit_code !== EXIT.ok ? handBack("internal") : null);
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
				hand_back: hb,
			})
		);
	} else {
		for (const l of r.text ?? []) out(l);
		for (const l of r.textErr ?? []) err(l);
		if (hb && r.exit_code !== EXIT.ok)
			err(`commertize-agent: ${hb.reason}: ${hb.by === "principal" ? "the person you act for continues at" : "see"} ${hb.url}`);
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
