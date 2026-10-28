// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// configure: credentials in the OS keychain. Every test uses a fake runner; none touches a real keychain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommertizeClient, ROUTES, type Route } from "../src/index.ts";
import { osKeychain, KEYCHAIN_SERVICE, SECURITY_BIN, securityBinOk, type Runner } from "../src/keychain.ts";
import { main } from "../src/cli.ts";

const TOKEN = "tok_ABCdef0123456789";

function fakeRunner(store = new Map<string, string>()) {
	const calls: { args: string[]; input?: string }[] = [];
	const run: Runner = (args, input) => {
		calls.push({ args, input });
		if (args[0] === "-i") {
			const m = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(input ?? "");
			if (!m) return { status: 1, stdout: "" };
			store.set(`${m[1]}/${m[2]}`, m[3]!);
			return { status: 0, stdout: "" };
		}
		const s = args[args.indexOf("-s") + 1];
		const a = args[args.indexOf("-a") + 1];
		const k = `${s}/${a}`;
		if (args[0] === "find-generic-password") return store.has(k) ? { status: 0, stdout: args.includes("-w") ? store.get(k)! + "\n" : "attrs" } : { status: 44, stdout: "" };
		if (args[0] === "delete-generic-password") return { status: store.delete(k) ? 0 : 44, stdout: "" };
		return { status: 1, stdout: "" };
	};
	return { run, calls, store };
}

test("keychain: the value goes on stdin, never on argv; one service, allowlisted names", () => {
	const f = fakeRunner();
	const kc = osKeychain(f.run, () => true);
	kc.set("COMMERTIZE_API_KEY", TOKEN);
	for (const c of f.calls) assert.ok(!c.args.join(" ").includes(TOKEN), "value on argv");
	assert.equal(f.store.get(`${KEYCHAIN_SERVICE}/COMMERTIZE_API_KEY`), TOKEN);
	assert.equal(kc.get("COMMERTIZE_API_KEY"), TOKEN);
	assert.throws(() => kc.set("HOME" as never, TOKEN), /keychain name/);
});

test("keychain: a value that could inject a second command or flag is refused before any call", () => {
	const f = fakeRunner();
	const kc = osKeychain(f.run, () => true);
	for (const v of ["abc def12345", "abcdefgh\ndelete-keychain login", 'abc"defgh', "-wabcdefgh", "short", "x".repeat(5000), "abcdefgh;rm", "abécdefgh"])
		assert.throws(() => kc.set("COMMERTIZE_API_KEY", v), /disallowed shape/, JSON.stringify(v));
	assert.equal(f.calls.length, 0);
});

test("keychain: a stored value with a bad shape is refused on read, not used", () => {
	const f = fakeRunner(new Map([[`${KEYCHAIN_SERVICE}/COMMERTIZE_API_KEY`, "bad value with spaces"]]));
	assert.throws(() => osKeychain(f.run, () => true).get("COMMERTIZE_API_KEY"), /disallowed shape/);
});

test("keychain: without the macOS keychain, set/clear refuse and reads return nothing (no file fallback)", () => {
	const f = fakeRunner();
	const kc = osKeychain(f.run, () => false);
	assert.throws(() => kc.set("COMMERTIZE_API_KEY", TOKEN), /no supported OS keychain/);
	assert.throws(() => kc.clear("COMMERTIZE_API_KEY"), /no supported OS keychain/);
	assert.equal(kc.get("COMMERTIZE_API_KEY"), undefined);
	assert.equal(f.calls.length, 0);
	assert.equal(securityBinOk(SECURITY_BIN, "linux"), false);
	assert.equal(securityBinOk("/nonexistent/security", "darwin"), false);
});

test("keychain: the security binary is called by absolute path with a fixed PATH (source pin)", () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "keychain.ts"), "utf8");
	assert.match(src, /spawnSync\(SECURITY_BIN,/);
	assert.match(src, /SECURITY_BIN = "\/usr\/bin\/security"/);
	assert.match(src, /env: \{ PATH: "\/usr\/bin:\/bin" \}/);
	assert.doesNotMatch(src, /shell:\s*true/);
});

async function cfg(argv: string[], kc: ReturnType<typeof osKeychain>, stdin = "") {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main(argv, (l) => out.push(l), (l) => err.push(l), { keychain: kc, readStdin: async () => stdin });
	return { code, out, err, o: argv.includes("--json") ? JSON.parse(out.at(-1)!) : null };
}

test("configure: status reports presence only, never values", async () => {
	const f = fakeRunner(new Map([[`${KEYCHAIN_SERVICE}/COMMERTIZE_API_KEY`, TOKEN]]));
	const r = await cfg(["configure", "--json"], osKeychain(f.run, () => true));
	assert.equal(r.code, 0);
	assert.deepEqual(r.o.data.stored, { COMMERTIZE_SESSION_TOKEN: false, COMMERTIZE_API_KEY: true });
	assert.equal(r.o.data.keychain_available, true);
	assert.doesNotMatch(r.out.join("") + r.err.join(""), new RegExp(TOKEN));
	assert.ok(!f.calls.some((c) => c.args.includes("-w")), "status never reads a value");
});

test("configure --api-key-stdin stores from stdin; the value never reaches stdout/stderr", async () => {
	const f = fakeRunner();
	const r = await cfg(["configure", "--api-key-stdin", "--json"], osKeychain(f.run, () => true), TOKEN + "\n");
	assert.equal(r.code, 0);
	assert.equal(f.store.get(`${KEYCHAIN_SERVICE}/COMMERTIZE_API_KEY`), TOKEN);
	assert.doesNotMatch(r.out.join("") + r.err.join(""), new RegExp(TOKEN));
	assert.equal(r.o.data.stored.COMMERTIZE_API_KEY, true);
});

test("configure: a credential on argv is refused (no --api-key VALUE form exists)", async () => {
	const f = fakeRunner();
	const r = await cfg(["configure", "--api-key", TOKEN, "--json"], osKeychain(f.run, () => true));
	assert.equal(r.code, 2);
	assert.equal(f.calls.length, 0);
	assert.doesNotMatch(r.out.join(""), new RegExp(TOKEN), "the usage error does not echo the value");
});

test("configure: both stdin flags at once, empty stdin, no keychain: all refuse, nothing stored", async () => {
	const f = fakeRunner();
	const kc = osKeychain(f.run, () => true);
	assert.equal((await cfg(["configure", "--api-key-stdin", "--session-token-stdin", "--json"], kc, TOKEN)).code, 2);
	assert.equal((await cfg(["configure", "--api-key-stdin", "--json"], kc, "")).code, 1);
	const none = await cfg(["configure", "--api-key-stdin", "--json"], osKeychain(f.run, () => false), TOKEN);
	assert.equal(none.code, 1);
	assert.match(none.o.next_step, /COMMERTIZE_API_KEY/);
	assert.equal(f.store.size, 0);
});

test("configure --clear NAME removes it; an unknown name is refused", async () => {
	const f = fakeRunner(new Map([[`${KEYCHAIN_SERVICE}/COMMERTIZE_SESSION_TOKEN`, TOKEN]]));
	const kc = osKeychain(f.run, () => true);
	const r = await cfg(["configure", "--clear", "COMMERTIZE_SESSION_TOKEN", "--json"], kc);
	assert.equal(r.code, 0);
	assert.equal(f.store.size, 0);
	assert.equal((await cfg(["configure", "--clear", "PATH", "--json"], kc)).code, 1);
});

test("credentials: the environment wins; the keychain fills only what the environment lacks", async () => {
	const f = fakeRunner(new Map([[`${KEYCHAIN_SERVICE}/COMMERTIZE_SESSION_TOKEN`, "kc_session_12345678"]]));
	const saved = { ...process.env };
	const seen: string[] = [];
	const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
		seen.push(String((init?.headers as Record<string, string>).authorization));
		return new Response(JSON.stringify({ agents: [] }), { status: 200 });
	}) as typeof fetch;
	try {
		delete process.env.COMMERTIZE_API_BASE_URL;
		delete process.env.COMMERTIZE_SESSION_TOKEN;
		const { clientFromEnv } = await import("../src/cli.ts");
		await clientFromEnv(undefined, () => {}, osKeychain(f.run, () => true), fetchImpl).call("principalAgents");
		process.env.COMMERTIZE_SESSION_TOKEN = "env_session_12345678";
		await clientFromEnv(undefined, () => {}, osKeychain(f.run, () => true), fetchImpl).call("principalAgents");
	} finally {
		process.env = saved;
	}
	assert.deepEqual(seen, ["Bearer kc_session_12345678", "Bearer env_session_12345678"]);
});

test("auth complete: with a keychain, the approved credential is stored there and reported 'stored'", async () => {
	const f = fakeRunner();
	const routes: Record<string, Route> = {};
	for (const [k, v] of Object.entries(ROUTES)) routes[k] = { ...v, status: "live" } as Route;
	const fetchImpl = (async () => new Response(JSON.stringify({ status: "approved", sessionToken: TOKEN }), { status: 200 })) as unknown as typeof fetch;
	const out: string[] = [];
	const code = await main(["auth", "complete", "--request", "req_ABCdef123456", "--json"], (l) => out.push(l), () => {}, {
		client: () => new CommertizeClient({ baseUrl: "https://api.commertize.com" }, fetchImpl, routes),
		keychain: osKeychain(f.run, () => true),
	});
	assert.equal(code, 0);
	assert.equal(JSON.parse(out[0]!).data.credential, "stored");
	assert.equal(f.store.get(`${KEYCHAIN_SERVICE}/COMMERTIZE_SESSION_TOKEN`), TOKEN);
	assert.doesNotMatch(out.join(""), new RegExp(TOKEN));
});

test("bin.ts is the only place the real OS keychain is wired (library and tests default to none)", () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
	assert.match(readFileSync(join(dir, "bin.ts"), "utf8"), /keychain: osKeychain\(\)/);
	assert.doesNotMatch(readFileSync(join(dir, "cli.ts"), "utf8"), /osKeychain\(/);
});
