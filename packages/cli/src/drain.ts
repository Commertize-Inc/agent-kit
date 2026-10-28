// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `events drain`: read-and-ack in one step, from an NDJSON file that
 * `events listen --json >> file` appends to.
 *
 * Each consumer keeps a cursor next to the file (`<file>.<consumer>.cursor`):
 * the byte offset it has acknowledged. One drain takes the next batch of
 * complete lines after that offset, moves the cursor past them (an atomic
 * rename), and only then returns them. Two drains of the same consumer can
 * never return the same line: a lock file makes them take turns, and a
 * second drain while one runs exits 9 (busy).
 *
 * Retry safety: pass `--key K`. The cursor remembers the last batch and its
 * key. A drain with the same key (and the same filters and limit) returns
 * that same batch again, byte for byte, and moves nothing. So a harness that
 * crashed after a drain and before handling the batch retries with the same
 * key and loses nothing; a harness that did handle it moves on with a new
 * key. Without a key a drain is at most once.
 *
 * A line the writer has not finished (no trailing newline) is never taken.
 * Lines that are not kit events are acknowledged and counted, never guessed
 * at. Events the filters exclude are acknowledged too: use a separate
 * consumer name for each filter set.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { EVENT_SCHEMA, matchesFilter, type EventFilter, type KitEvent } from "./events.ts";

export const DRAIN_LIMIT_DEFAULT = 100;
export const DRAIN_LIMIT_MAX = 1000;
/** Most bytes one drain reads past the cursor. */
export const DRAIN_MAX_BYTES = 8 * 1024 * 1024;
const CONSUMER = /^[a-z0-9_-]{1,32}$/;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

export class DrainBusyError extends Error {
	constructor(lock: string) {
		super(`another drain holds ${lock}; retry after it finishes`);
		this.name = "DrainBusyError";
	}
}

export class DrainSourceChangedError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "DrainSourceChangedError";
	}
}

export class DrainUsageError extends Error {
	constructor(msg: string) {
		super(msg);
		this.name = "DrainUsageError";
	}
}

interface Cursor {
	v: 1;
	dev: number;
	ino: number;
	offset: number;
	last?: { key: string; batch_id: string; start: number; end: number; shape: string };
}

export interface DrainOptions {
	file: string;
	consumer?: string;
	limit?: number;
	key?: string;
	filter?: EventFilter;
}

export interface DrainResult {
	batch_id: string;
	consumer: string;
	events: KitEvent[];
	/** Lines in this batch that were not kit events (acknowledged, not returned). */
	skipped: number;
	/** Kit events in this batch that the filters excluded (acknowledged, not returned). */
	filtered: number;
	/** The acknowledged byte offset after this batch. */
	offset: number;
	/** true when complete lines remain after this batch. */
	more: boolean;
	/** true when this is a repeat of the last batch (same --key). */
	redelivered: boolean;
}

export function cursorPath(file: string, consumer: string): string {
	return `${file}.${consumer}.cursor`;
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Exclusive lock: O_EXCL create. A lock whose writer is gone is taken over once. */
function lock(path: string): () => void {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => {
				try {
					unlinkSync(path);
				} catch {
					/* already gone */
				}
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			let holder = NaN;
			try {
				holder = Number(readFileSync(path, "utf8").trim());
			} catch {
				/* unreadable: treat as held */
			}
			if (Number.isNaN(holder) || pidAlive(holder) || attempt > 0) throw new DrainBusyError(path);
			try {
				unlinkSync(path);
			} catch {
				/* raced: next attempt decides */
			}
		}
	}
	throw new DrainBusyError(path);
}

function readCursor(path: string): Cursor | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	const c = JSON.parse(raw) as Cursor;
	if (c?.v !== 1 || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new DrainSourceChangedError(`${path} is not a drain cursor this kit wrote`);
	return c;
}

function writeCursor(path: string, c: Cursor): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(c) + "\n", { mode: 0o600 });
	renameSync(tmp, path);
}

function readRange(fd: number, start: number, end: number): Buffer {
	const buf = Buffer.alloc(end - start);
	let off = 0;
	while (off < buf.length) {
		const n = readSync(fd, buf, off, buf.length - off, start + off);
		if (n === 0) break;
		off += n;
	}
	return buf.subarray(0, off);
}

/** Parses one line: a kit event, or null for anything else. */
function parseEvent(line: string): KitEvent | null {
	let e: KitEvent;
	try {
		e = JSON.parse(line);
	} catch {
		return null;
	}
	if (e?.schema !== EVENT_SCHEMA || typeof e.type !== "string" || typeof e.data !== "object" || e.data === null || typeof e.ts !== "string") return null;
	return e;
}

export function drain(o: DrainOptions): DrainResult {
	const consumer = o.consumer ?? "default";
	if (!CONSUMER.test(consumer)) throw new DrainUsageError("--consumer is 1-32 characters of a-z 0-9 _ -");
	const limit = o.limit ?? DRAIN_LIMIT_DEFAULT;
	if (!Number.isInteger(limit) || limit < 1 || limit > DRAIN_LIMIT_MAX) throw new DrainUsageError(`--limit is 1-${DRAIN_LIMIT_MAX}`);
	if (o.key !== undefined && !KEY.test(o.key)) throw new DrainUsageError("--key is 1-64 characters of A-Z a-z 0-9 _ -");
	const shape = JSON.stringify({ limit, types: o.filter?.types ? [...o.filter.types].sort() : null, since: o.filter?.sinceMs ?? null, job: o.filter?.job ?? null });

	const cpath = cursorPath(o.file, consumer);
	const unlock = lock(`${cpath}.lock`);
	try {
		const fd = openSync(o.file, "r");
		try {
			const st = fstatSync(fd);
			if (!st.isFile()) throw new DrainUsageError(`${o.file} is not a regular file`);
			const cur = readCursor(cpath) ?? { v: 1 as const, dev: st.dev, ino: st.ino, offset: 0 };
			if (cur.dev !== st.dev || cur.ino !== st.ino)
				throw new DrainSourceChangedError(`${o.file} is not the file this cursor was taken on (replaced or rotated); use a new --consumer name`);
			if (st.size < cur.offset) throw new DrainSourceChangedError(`${o.file} is shorter than the acknowledged offset (truncated); use a new --consumer name`);

			const redeliver = o.key !== undefined && cur.last?.key === o.key;
			if (redeliver && cur.last!.shape !== shape) throw new DrainUsageError("--key was used with different --limit or filters; use a new key");
			const start = redeliver ? cur.last!.start : cur.offset;
			const hardEnd = redeliver ? cur.last!.end : Math.min(st.size, start + DRAIN_MAX_BYTES);
			// Offsets are bytes: lines are cut on the raw buffer, so invalid UTF-8 cannot shift them.
			const buf = readRange(fd, start, hardEnd);

			const events: KitEvent[] = [];
			let skipped = 0;
			let filtered = 0;
			let pos = 0; // bytes consumed (complete lines only)
			while (pos < buf.length && (redeliver || events.length < limit)) {
				const nl = buf.indexOf(0x0a, pos);
				if (nl < 0) break; // an unfinished line is never taken
				const line = buf.subarray(pos, nl).toString("utf8");
				pos = nl + 1;
				if (!line.trim()) continue;
				const e = parseEvent(line);
				if (!e) skipped++;
				else if (!matchesFilter(e, o.filter)) filtered++;
				else events.push(e);
			}
			if (!redeliver && pos === 0 && buf.length >= DRAIN_MAX_BYTES)
				throw new DrainSourceChangedError(`a line longer than ${DRAIN_MAX_BYTES} bytes at offset ${start}; use a new --consumer name`);
			const end = start + pos;
			const batch_id = createHash("sha256").update(`${st.dev}:${st.ino}:${consumer}:${start}:${end}`).digest("hex").slice(0, 32);
			if (!redeliver) {
				const next: Cursor = { v: 1, dev: st.dev, ino: st.ino, offset: end };
				if (o.key !== undefined) next.last = { key: o.key, batch_id, start, end, shape };
				writeCursor(cpath, next); // the ack; it happens before the batch is returned
			}
			const acked = redeliver ? cur.offset : end;
			return { batch_id, consumer, events, skipped, filtered, offset: acked, more: st.size > acked && hasCompleteLine(fd, acked, st.size), redelivered: redeliver };
		} finally {
			closeSync(fd);
		}
	} finally {
		unlock();
	}
}

/** True when a newline exists in [from, to): a complete line is waiting. Reads at most DRAIN_MAX_BYTES. */
function hasCompleteLine(fd: number, from: number, to: number): boolean {
	return readRange(fd, from, Math.min(to, from + DRAIN_MAX_BYTES)).includes(0x0a);
}
