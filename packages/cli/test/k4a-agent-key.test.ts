// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// K-4a: agent key import (stdin only, create-only, must match the active agent), key status,
// and sign-typed-data that signs nothing (the allowed list is empty).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toChecksumAddress } from "../src/keccak.ts";
import { addressOf, AGENT_KEY, classifyTypedData } from "../src/agentkey.ts";
import { checkValue, osKeychain, type Keychain, type KeyName, type Runner } from "../src/keychain.ts";
import { main } from "../src/cli.ts";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const KEY_ONE = "0x" + "00".repeat(31) + "01";
const ADDR_ONE = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const KEY_TWO = "0x" + "00".repeat(31) + "02";
const ADDR_TWO = "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF";
const N = "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

function memKeychain() {
	const store = new Map<KeyName, string>();
	const reads: KeyName[] = [];
	const kc: Keychain = {
		available: () => true,
		has: (n) => store.has(n),
		get: (n) => (reads.push(n), store.get(n)),
		set: () => {
			throw new Error("import must not use set (it replaces)");
		},
		clear: (n) => store.delete(n),
		add: (n, v) => (store.has(n) ? "exists" : (store.set(n, checkValue(v)), "added")),
	};
	return { kc, store, reads };
}

function homeWithActive(address: string | null) {
	const home = mkdtempSync(join(tmpdir(), "kit-k4-home-"));
	if (address) {
		mkdirSync(join(home, ".commertize", "profiles"), { recursive: true, mode: 0o700 });
		writeFileSync(join(home, ".commertize", "profiles", "default.json"), JSON.stringify({ v: 1, passportId: "aaaaaaaa-0000-4000-8000-000000000001", agentAddress: address, setAt: "2026-10-28T00:00:00.000Z" }), { mode: 0o600 });
	}
	return home;
}

async function run(argv: string[], o: { kc?: Keychain; stdin?: string; home?: string } = {}) {
	const out: string[] = [];
	const err: string[] = [];
	let stdinReads = 0;
	const code = await main([...argv, "--json"], (l) => out.push(l), (l) => err.push(l), {
		keychain: o.kc,
		readStdin: async () => (stdinReads++, o.stdin ?? ""),
		home: o.home ?? homeWithActive(null),
		signals: false,
	});
	return { code, o: JSON.parse(out.at(-1)!), raw: out.join("\n") + err.join("\n"), stdinReads };
}

// --- keccak and addresses -------------------------------------------------------

test("keccak256 and EIP-55: known vectors", () => {
	assert.equal(hex(keccak256(new Uint8Array(0))), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
	assert.equal(hex(keccak256(Buffer.from("abc"))), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
	assert.equal(toChecksumAddress("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
	assert.equal(addressOf(KEY_ONE), ADDR_ONE);
	assert.equal(addressOf(KEY_TWO), ADDR_TWO);
	assert.equal(addressOf(KEY_ONE.toUpperCase().replace("0X", "0x")), ADDR_ONE);
});

test("addressOf: zero, n and beyond, and malformed keys are refused; the message never carries the key", () => {
	const nPlus1 = "0x" + (BigInt(N) + 1n).toString(16);
	for (const bad of ["0x" + "00".repeat(32), N, nPlus1, "0x1234", "1".repeat(64), "0x" + "g".repeat(64)]) {
		assert.throws(() => addressOf(bad), (e: Error) => !e.message.includes(bad.slice(2, 20)) || bad.length < 12, bad);
	}
	// zero and n and above are refused by the kit's own range check, not by the crypto library
	for (const bad of ["0x" + "00".repeat(32), N, nPlus1]) assert.throws(() => addressOf(bad), /outside the secp256k1 range/, bad);
	assert.equal(addressOf("0x" + (BigInt(N) - 1n).toString(16)).length, 42, "n-1 is the largest valid key");
});

// --- wallet key import / status ---------------------------------------------------

test("wallet key import --stdin: stores create-only, prints the address and never the key; status reads it back", async () => {
	const m = memKeychain();
	const r = await run(["wallet", "key", "import", "--stdin"], { kc: m.kc, stdin: KEY_ONE + "\n" });
	assert.equal(r.code, 0);
	assert.equal(r.o.data.address, ADDR_ONE);
	assert.equal(r.o.data.matches_active_agent, null);
	assert.equal(m.store.get(AGENT_KEY), KEY_ONE);
	assert.doesNotMatch(r.raw, /0{62}01/, "the key is never printed");
	const s = await run(["wallet", "key", "status"], { kc: m.kc });
	assert.deepEqual(s.o.data, { stored: true, address: ADDR_ONE });
	assert.doesNotMatch(s.raw, /0{62}01/);
});

test("wallet key import: an existing key is never replaced; a key for another address than the active agent is refused before any write", async () => {
	const m = memKeychain();
	await run(["wallet", "key", "import", "--stdin"], { kc: m.kc, stdin: KEY_ONE });
	const again = await run(["wallet", "key", "import", "--stdin"], { kc: m.kc, stdin: KEY_TWO });
	assert.equal(again.code, 1);
	assert.equal(again.o.hand_back.reason, "agent_key_exists");
	assert.equal(m.store.get(AGENT_KEY), KEY_ONE);
	const fresh = memKeychain();
	const mismatch = await run(["wallet", "key", "import", "--stdin"], { kc: fresh.kc, stdin: KEY_TWO, home: homeWithActive(ADDR_ONE) });
	assert.equal(mismatch.code, 1);
	assert.match(mismatch.o.error.message, /not the active agent/);
	assert.equal(fresh.store.size, 0);
	const ok = await run(["wallet", "key", "import", "--stdin"], { kc: fresh.kc, stdin: KEY_ONE, home: homeWithActive(ADDR_ONE.toLowerCase()) });
	assert.equal(ok.code, 0);
	assert.equal(ok.o.data.matches_active_agent, true);
});

test("wallet key import: never from argv; no --stdin means usage, and stdin is not read; a bad key stores nothing and is not echoed", async () => {
	const m = memKeychain();
	const argvKey = await run(["wallet", "key", "import", KEY_ONE], { kc: m.kc, stdin: KEY_ONE });
	assert.equal(argvKey.code, 2);
	assert.equal(argvKey.stdinReads, 0);
	assert.doesNotMatch(JSON.stringify(argvKey.o), /0{62}01/, "a key passed on argv is not echoed back in the result");
	const noFlag = await run(["wallet", "key", "import"], { kc: m.kc, stdin: KEY_ONE });
	assert.equal(noFlag.code, 2);
	assert.equal(noFlag.stdinReads, 0);
	const bad = await run(["wallet", "key", "import", "--stdin"], { kc: m.kc, stdin: "0xdeadbeef" + "ab".repeat(27) }); // 62 hex characters: malformed
	assert.equal(bad.code, 1);
	assert.doesNotMatch(bad.raw, /deadbeef/);
	assert.equal(m.store.size, 0);
	for (const argv of [["wallet", "key"], ["wallet", "key", "export"], ["wallet", "key", "status", "--stdin"]]) assert.equal((await run(argv, { kc: m.kc })).code, 2, argv.join(" "));
});

test("wallet key import over the real keychain wrapper: a locked keychain (36) stops before any write; the add has no -U", async () => {
	const calls: { args: string[]; input?: string }[] = [];
	const locked: Runner = (args, input) => (calls.push({ args, input }), { status: args[0] === "find-generic-password" ? 36 : 0, stdout: "" });
	const r = await run(["wallet", "key", "import", "--stdin"], { kc: osKeychain(locked, () => true), stdin: KEY_ONE });
	assert.equal(r.code, 1);
	assert.ok(!calls.some((c) => c.args[0] === "-i"));
	let stored: string | undefined;
	const ok: Runner = (args, input) => {
		calls.push({ args, input });
		if (args[0] === "-i") {
			stored = /-w (\S+)\n$/.exec(input ?? "")?.[1];
			return { status: 0, stdout: "" };
		}
		if (args[0] === "find-generic-password") return args.includes("-w") && stored ? { status: 0, stdout: stored + "\n" } : { status: 44, stdout: "" };
		return { status: 1, stdout: "" };
	};
	calls.length = 0;
	const g = await run(["wallet", "key", "import", "--stdin"], { kc: osKeychain(ok, () => true), stdin: KEY_ONE });
	assert.equal(g.code, 0);
	const add = calls.find((c) => c.args[0] === "-i")!;
	assert.match(add.input!, /^add-generic-password -s commertize-agent-kit -a COMMERTIZE_AGENT_KEY -w /);
	assert.doesNotMatch(add.input!, / -U /);
	assert.ok(!calls.some((c) => c.args.join(" ").includes("0000000001")), "the key is never on argv");
});

// --- sign-typed-data: everything refused ------------------------------------------

function tdFile(td: unknown) {
	const p = join(mkdtempSync(join(tmpdir(), "kit-td-")), "td.json");
	writeFileSync(p, typeof td === "string" ? td : JSON.stringify(td));
	return p;
}
const casMandate = {
	types: { EIP712Domain: [], Mandate: [] },
	primaryType: "Mandate",
	domain: { name: "CAS Mandate", version: "1", chainId: 84532, verifyingContract: "0x" + "1".repeat(40) },
	message: {},
};
const permit2 = { types: { EIP712Domain: [], PermitSingle: [] }, primaryType: "PermitSingle", domain: { name: "Permit2", chainId: 8453 }, message: {} };
const eip2612 = { types: { EIP712Domain: [], Permit: [] }, primaryType: "Permit", domain: { name: "USD Coin", version: "2" }, message: {} };
const other = { types: { EIP712Domain: [], Mail: [] }, primaryType: "Mail", domain: { name: "Ether Mail" }, message: {} };
const disguised = { types: { EIP712Domain: [], Order: [], PermitBatchTransferFrom: [] }, primaryType: "Order", domain: { name: "Some DEX" }, message: {} };

test("classifyTypedData: CAS mandate, permits (incl. a permit type hidden behind another primary type), everything else", () => {
	assert.equal(classifyTypedData(casMandate).class, "cas_mandate");
	assert.equal(classifyTypedData(permit2).class, "permit");
	assert.equal(classifyTypedData(eip2612).class, "permit");
	assert.equal(classifyTypedData(disguised).class, "permit");
	assert.equal(classifyTypedData(other).class, "other");
	assert.equal(classifyTypedData(null).class, "other");
});

test("wallet sign-typed-data: refuses every payload (exit 4), signs nothing, never reads the agent key", async () => {
	const m = memKeychain();
	await run(["wallet", "key", "import", "--stdin"], { kc: m.kc, stdin: KEY_ONE });
	m.reads.length = 0;
	const cases: [unknown, string, string][] = [
		[casMandate, "mandate_request", "principal"],
		[permit2, "payments_not_open", "agent"],
		[eip2612, "payments_not_open", "agent"],
		[disguised, "payments_not_open", "agent"],
		[other, "typed_data_not_allowlisted", "agent"],
	];
	for (const [td, reason, by] of cases) {
		const r = await run(["wallet", "sign-typed-data", "--file", tdFile(td)], { kc: m.kc });
		assert.equal(r.code, 4, reason);
		assert.equal(r.o.data.signed, false);
		assert.equal(r.o.hand_back.reason, reason);
		assert.equal(r.o.hand_back.by, by);
		assert.doesNotMatch(r.raw, /"signature"|0x[0-9a-f]{130}/i);
	}
	assert.deepEqual(m.reads, [], "the agent key is never read to refuse");
});

test("wallet sign-typed-data: a FIFO, an oversized file or non-JSON is refused before any classification", async () => {
	const fifo = join(mkdtempSync(join(tmpdir(), "kit-td-fifo-")), "td.json");
	assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
	assert.equal((await run(["wallet", "sign-typed-data", "--file", fifo])).code, 1);
	const big = await run(["wallet", "sign-typed-data", "--file", tdFile({ ...casMandate, pad: "x".repeat(256 * 1024) })]);
	assert.equal(big.code, 1, "valid JSON over the cap is still refused");
	assert.match(big.o.error.message, /larger than/);
	assert.equal((await run(["wallet", "sign-typed-data", "--file", tdFile("{not json")])).code, 1);
	for (const argv of [["wallet", "sign-typed-data"], ["wallet", "sign-typed-data", "x.json"]]) assert.equal((await run(argv)).code, 2, argv.join(" "));
});

test("configure --clear removes the agent key; it is not listed as a credential", async () => {
	const m = memKeychain();
	await run(["wallet", "key", "import", "--stdin"], { kc: m.kc, stdin: KEY_ONE });
	const c = await run(["configure"], { kc: m.kc });
	assert.deepEqual(Object.keys(c.o.data.stored), ["COMMERTIZE_SESSION_TOKEN", "COMMERTIZE_API_KEY"]);
	assert.equal((await run(["configure", "--clear", AGENT_KEY], { kc: m.kc })).code, 0);
	assert.equal(m.store.size, 0);
});

test("wallet key import: when the keychain's create reports an existing item, that is agent_key_exists, whatever the read-back says", async () => {
	const kc: Keychain = {
		available: () => true,
		has: () => false,
		get: () => undefined,
		set: () => {
			throw new Error("no set");
		},
		clear: () => false,
		add: () => "exists",
	};
	const r = await run(["wallet", "key", "import", "--stdin"], { kc, stdin: KEY_ONE });
	assert.equal(r.code, 1);
	assert.equal(r.o.hand_back.reason, "agent_key_exists");
});
