// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Events for a harness to follow: newline-delimited JSON, one object per line.
 *
 * Source: the public Work board (GET /work/v1/tasks), polled. There is no
 * push channel on the public API, so the kit polls (floor 15 s) and emits
 * what changed. Nothing is invented: an event exists only because two board
 * reads differed.
 *
 *   events listen        every board change, until stopped
 *   job watch <task>     one task, until it reaches a final state
 *   job history <task>   that task's events from a file a listener wrote
 *   events serve         the same stream over loopback HTTP (see serve.ts)
 *
 * Every event line carries `availableTools`: the kit commands valid in the
 * state that event reports. A line that ends something (a task reaching a
 * final state or leaving the board, the stream stopping) also carries a
 * `hand_back` (see handback.ts).
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { ApiError, CommertizeClient } from "./client.ts";
import { RouteMissingError } from "./routes.ts";
import { handBack, TASK_FINAL, taskFinal, type HandBack } from "./handback.ts";

export const EVENT_SCHEMA = "commertize.agent-kit.event.v1";
export const POLL_FLOOR_MS = 15_000;
export const POLL_DEFAULT_MS = 30_000;
export const BACKOFF_CAP_MS = 5 * 60_000;
/** States after which a task does not change again. */
export const FINAL_STATES: ReadonlySet<string> = new Set(Object.keys(TASK_FINAL));

export const EVENT_TYPES = [
	"stream.started",
	"stream.error",
	"stream.stopped",
	"work.board.snapshot",
	"work.task.opened",
	"work.task.changed",
	"work.task.removed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface KitEvent {
	schema: typeof EVENT_SCHEMA;
	seq: number;
	ts: string;
	type: EventType;
	data: Record<string, unknown>;
	/** The kit commands valid in the state this event reports (command names, e.g. "job watch"). */
	availableTools: string[];
	/** Present when the event ends something: a task's final state, its removal, the stream stopping. */
	hand_back?: HandBack;
}

/** Commands for one task: a task that can still change can be watched; any task has a history. */
function taskTools(status: unknown): string[] {
	return taskFinal(status) ? ["job history"] : ["job watch", "job history"];
}

/**
 * The exact set of kit commands valid in the state an event reports. A pure
 * function of the event: the same line always gives the same set.
 */
export function availableTools(type: EventType, data: Record<string, unknown>): string[] {
	switch (type) {
		case "stream.started":
		case "stream.error":
			return ["routes"];
		case "stream.stopped":
			return data.reason === "route_missing" ? ["routes"] : ["events listen", "job history"];
		case "work.board.snapshot": {
			const tasks = Array.isArray(data.tasks) ? (data.tasks as { status?: unknown }[]) : [];
			const set = new Set<string>();
			for (const t of tasks) for (const c of taskTools(t?.status)) set.add(c);
			return ["job watch", "job history"].filter((c) => set.has(c));
		}
		case "work.task.opened":
		case "work.task.changed":
			return taskTools(data.status);
		case "work.task.removed":
			return ["job history"];
	}
}

/** The hand-back an event carries, or undefined when the event ends nothing. */
export function eventHandBack(type: EventType, data: Record<string, unknown>): HandBack | undefined {
	if (type === "stream.stopped")
		return handBack(data.reason === "route_missing" ? "route_not_open" : data.reason === "aborted" ? "aborted" : "stream_stopped");
	if (type === "work.task.removed") return handBack("task_removed");
	if (type === "work.task.changed" || type === "work.task.opened") {
		const f = taskFinal(data.status);
		return f ? handBack(f.reason) : undefined;
	}
	return undefined;
}

/**
 * Event filters (`--type`, `--since`, `--job`). stream.error and
 * stream.stopped always pass, so a filtered reader still sees failures and
 * the end of the stream.
 */
export interface EventFilter {
	types?: ReadonlySet<string>;
	/** Only events whose ts is at or after this instant (ms since epoch). An unparseable ts does not pass. */
	sinceMs?: number;
	/** Only events about this task (a snapshot passes when it lists the task; stream.started always passes). */
	job?: string;
}

export function matchesFilter(e: { type: string; ts: string; data: Record<string, unknown> }, f: EventFilter | undefined): boolean {
	if (!f) return true;
	if (e.type === "stream.error" || e.type === "stream.stopped") return true;
	if (f.types && !f.types.has(e.type)) return false;
	if (f.sinceMs !== undefined && !(Date.parse(e.ts) >= f.sinceMs)) return false;
	if (f.job !== undefined && e.type !== "stream.started") {
		const inSnapshot =
			e.type === "work.board.snapshot" && Array.isArray(e.data.tasks) && e.data.tasks.some((t: { task_id?: unknown }) => t?.task_id === f.job);
		if (e.data.task_id !== f.job && !inSnapshot) return false;
	}
	return true;
}

interface BoardTask {
	task_id: string;
	status: string;
	task_class?: string;
	deadline?: string;
}

export type Board = Map<string, BoardTask>;

/** Reads the board. Rows without a string task_id and status are dropped, not guessed. */
export async function readBoard(client: CommertizeClient): Promise<Board> {
	const r = await client.call<{ tasks?: unknown }>("workTasks");
	const m: Board = new Map();
	for (const t of Array.isArray(r?.tasks) ? r.tasks : []) {
		const x = t as Record<string, unknown>;
		if (typeof x?.task_id !== "string" || typeof x?.status !== "string") continue;
		m.set(x.task_id, {
			task_id: x.task_id,
			status: x.status,
			...(typeof x.task_class === "string" ? { task_class: x.task_class } : {}),
			...(typeof x.deadline === "string" ? { deadline: x.deadline } : {}),
		});
	}
	return m;
}

export function diffBoard(prev: Board, next: Board): { type: EventType; data: Record<string, unknown> }[] {
	const out: { type: EventType; data: Record<string, unknown> }[] = [];
	for (const [id, t] of next) {
		const p = prev.get(id);
		if (!p) out.push({ type: "work.task.opened", data: { ...t } });
		else if (p.status !== t.status) out.push({ type: "work.task.changed", data: { ...t, previous_status: p.status } });
	}
	for (const [id, p] of prev) if (!next.has(id)) out.push({ type: "work.task.removed", data: { task_id: id, previous_status: p.status } });
	return out;
}

export interface ListenOptions {
	client: CommertizeClient;
	emit: (e: KitEvent) => void;
	intervalMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => Date;
	/** Return true to stop after this event (job watch uses it). */
	stopWhen?: (e: KitEvent) => boolean;
	/** Only emit work.* events for this task id. */
	taskId?: string;
	/** Stop after this many board reads (tests, --once). */
	maxPolls?: number;
	signal?: AbortSignal;
}

export interface ListenOutcome {
	reason: "stopped" | "max_polls" | "aborted" | "route_missing";
	polls: number;
	events: number;
	message?: string;
	/** For a watch that stopped: the task's final status, or "removed" when it left the board. */
	final?: { task_id: string; status: string };
}

/**
 * Polls and emits. Transient errors (network, 5xx, 429, a switched-off 404)
 * emit stream.error and back off (doubling, cap 5 min); a route missing from
 * the table ends the stream, because no poll can succeed.
 */
export async function listen(o: ListenOptions): Promise<ListenOutcome> {
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = o.now ?? (() => new Date());
	const interval = Math.max(POLL_FLOOR_MS, o.intervalMs ?? POLL_DEFAULT_MS);
	let seq = 0;
	let events = 0;
	let polls = 0;
	let wait = interval;
	let prev: Board | null = null;
	let stop = false;
	let final: ListenOutcome["final"];
	const emit = (type: EventType, data: Record<string, unknown>) => {
		const e: KitEvent = { schema: EVENT_SCHEMA, seq: ++seq, ts: now().toISOString(), type, data, availableTools: availableTools(type, data) };
		const hb = eventHandBack(type, data);
		if (hb) e.hand_back = hb;
		o.emit(e);
		events++;
		if (o.stopWhen?.(e)) {
			stop = true;
			if (typeof data.task_id === "string")
				final = { task_id: data.task_id, status: type === "work.task.removed" ? "removed" : String(data.status) };
		}
	};
	const finish = (out: ListenOutcome): ListenOutcome => {
		emit("stream.stopped", { reason: out.reason });
		return { ...out, events, ...(final ? { final } : {}) };
	};
	emit("stream.started", { source: "GET /work/v1/tasks", interval_ms: interval, ...(o.taskId ? { task_id: o.taskId } : {}) });
	for (;;) {
		if (o.signal?.aborted) return finish({ reason: "aborted", polls, events });
		let board: Board | null = null;
		try {
			board = await readBoard(o.client);
			wait = interval;
		} catch (e) {
			if (e instanceof RouteMissingError) return finish({ reason: "route_missing", polls, events, message: e.message });
			const status = e instanceof ApiError ? e.status : undefined;
			// audit L-3: compute the next wait first, so retry_in_ms is the wait that actually follows
			wait = Math.min(BACKOFF_CAP_MS, wait * 2);
			emit("stream.error", { message: (e as Error).message, ...(status ? { status } : {}), retry_in_ms: wait });
		}
		polls++;
		if (board) {
			const scope = (m: Board): Board => (o.taskId ? new Map([...m].filter(([k]) => k === o.taskId)) : m);
			const cur = scope(board);
			if (prev === null) {
				emit("work.board.snapshot", { count: cur.size, tasks: [...cur.values()] });
				if (o.taskId && cur.size === 1 && o.stopWhen) {
					// a task that is already final ends the watch on the first read
					const t = cur.get(o.taskId)!;
					if (FINAL_STATES.has(t.status)) {
						stop = true;
						final = { task_id: t.task_id, status: t.status };
					}
				}
			} else for (const d of diffBoard(prev, cur)) emit(d.type, d.data);
			prev = cur;
		}
		if (stop) return finish({ reason: "stopped", polls, events });
		if (o.maxPolls !== undefined && polls >= o.maxPolls) return finish({ reason: "max_polls", polls, events });
		await sleep(board ? interval : wait);
	}
}

/** job watch stops on a final state or when the task leaves the board. */
export const watchStop = (taskId: string) => (e: KitEvent) =>
	e.data.task_id === taskId && (e.type === "work.task.removed" || (e.type === "work.task.changed" && FINAL_STATES.has(String(e.data.status))));

export const HISTORY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads an NDJSON file written by `events listen --json` (or events serve) and
 * returns that task's events in file order. Lines that are not kit events
 * are counted, never guessed at. Read-only.
 */
export function history(file: string, taskId: string): { events: KitEvent[]; skipped: number } {
	const fd = openSync(file, "r");
	let text: string;
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error(`${file} is not a regular file`);
		if (st.size > HISTORY_MAX_BYTES) throw new Error(`${file} is larger than ${HISTORY_MAX_BYTES} bytes`);
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < st.size) {
			const n = readSync(fd, buf, off, st.size - off, off);
			if (n === 0) break;
			off += n;
		}
		text = buf.subarray(0, off).toString("utf8");
	} finally {
		closeSync(fd);
	}
	const events: KitEvent[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let e: KitEvent;
		try {
			e = JSON.parse(line);
		} catch {
			skipped++;
			continue;
		}
		if (e?.schema !== EVENT_SCHEMA || typeof e.type !== "string" || typeof e.data !== "object" || e.data === null) {
			skipped++;
			continue;
		}
		const inSnapshot = e.type === "work.board.snapshot" && Array.isArray(e.data.tasks) && e.data.tasks.some((t: { task_id?: unknown }) => t?.task_id === taskId);
		if (e.data.task_id === taskId || inSnapshot) events.push(e);
	}
	return { events, skipped };
}
