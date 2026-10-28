// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `skill check --path <file>...`: is each installed copy of the operating
 * guide the one this kit release publishes (the SKILL.md inside the
 * package)? Compared by SHA-256 of the exact bytes. A file that is missing,
 * unreadable, not a regular file or too large counts as drift: the check
 * fails closed.
 */

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const SKILL_MAX_BYTES = 1024 * 1024;

export interface SkillFileCheck {
	path: string;
	sha256: string | null;
	upToDate: boolean;
	problem?: string;
}

export const sha256hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function readCapped(path: string): Buffer {
	const fd = openSync(path, "r");
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error("not a regular file");
		if (st.size > SKILL_MAX_BYTES) throw new Error(`larger than ${SKILL_MAX_BYTES} bytes`);
		const buf = Buffer.alloc(st.size);
		let off = 0;
		while (off < st.size) {
			const n = readSync(fd, buf, off, st.size - off, off);
			if (n === 0) break;
			off += n;
		}
		return buf.subarray(0, off);
	} finally {
		closeSync(fd);
	}
}

export function skillCheck(published: Buffer | string, paths: string[]): { skillHash: string; files: SkillFileCheck[]; upToDate: boolean } {
	const skillHash = sha256hex(published);
	const files = paths.map((path): SkillFileCheck => {
		try {
			const h = sha256hex(readCapped(path));
			return { path, sha256: h, upToDate: h === skillHash };
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			return { path, sha256: null, upToDate: false, problem: code === "ENOENT" ? "missing" : (e as Error).message };
		}
	});
	return { skillHash, files, upToDate: files.length > 0 && files.every((f) => f.upToDate) };
}
