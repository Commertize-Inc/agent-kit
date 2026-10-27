// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, CommertizeClient, KitConfigError, ROUTES, RouteMissingError, readEnv } from "../src/index.ts";
import { register } from "../src/register.ts";
import { init } from "../src/init.ts";
import { main } from "../src/cli.ts";
import { fakeFetch } from "./helpers.ts";

const ENV = { baseUrl: "https://api.example.test", sessionToken: "s-token", apiKey: "k-key" };
const ADDR = "0x" + "b".repeat(40);

// --- env --------------------------------------------------------------------
test("readEnv: https default; http only for loopback; no credentials in URL", () => {
	assert.equal(readEnv({}).baseUrl, "https://api.commertize.com");
	// The loopback base is built at runtime so the source carries no literal loopback host:port.
	const loopback = `http://${[127, 0, 0, 1].join(".")}:${8000 + 80}`;
	assert.equal(readEnv({ COMMERTIZE_API_BASE_URL: `${loopback}/` }).baseUrl, loopback);
	assert.throws(() => readEnv({ COMMERTIZE_API_BASE_URL: "http://api.commertize.com" }), KitConfigError);
	assert.throws(() => readEnv({ COMMERTIZE_API_BASE_URL: "https://u:p@api.commertize.com" }), KitConfigError);
	assert.throws(() => readEnv({ COMMERTIZE_API_BASE_URL: "https://api.commertize.com/?k=1" }), KitConfigError);
	assert.equal(readEnv({ COMMERTIZE_SESSION_TOKEN: "  " }).sessionToken, undefined);
});

test("readEnv: a lookalike or other host is refused; --allow-host must name it exactly and is announced", () => {
	const warned: string[] = [];
	const w = (m: string) => warned.push(m);
	for (const h of ["https://api.commertize.co", "https://api.commertize.com.evil.test", "https://commertize.com", "https://staging.example.test"])
		assert.throws(() => readEnv({ COMMERTIZE_API_BASE_URL: h }, undefined, w), /--allow-host/);
	assert.throws(() => readEnv({ COMMERTIZE_API_BASE_URL: "https://staging.example.test" }, "other.example.test", w), /--allow-host/);
	assert.equal(warned.length, 0);
	assert.equal(readEnv({ COMMERTIZE_API_BASE_URL: "https://staging.example.test" }, "staging.example.test", w).baseUrl, "https://staging.example.test");
	assert.equal(warned.length, 1);
	assert.match(warned[0]!, /staging\.example\.test/);
	assert.equal(readEnv({ COMMERTIZE_API_BASE_URL: "https://API.Commertize.com" }, undefined, w).baseUrl, "https://api.commertize.com");
	assert.equal(warned.length, 1);
});

test("cli register: a non-allowlisted base is refused before any network call", async () => {
	const prev = process.env.COMMERTIZE_API_BASE_URL;
	process.env.COMMERTIZE_API_BASE_URL = "https://api.commertize.co";
	const errs: string[] = [];
	try {
		assert.equal(await main(["register", "--agent-address", ADDR], () => {}, (l) => errs.push(l)), 1);
		assert.match(errs.join("\n"), /not api\.commertize\.com/);
	} finally {
		if (prev === undefined) delete process.env.COMMERTIZE_API_BASE_URL;
		else process.env.COMMERTIZE_API_BASE_URL = prev;
	}
});

// --- client -----------------------------------------------------------------
test("client: missing route throws before any network call", async () => {
	const { f, calls } = fakeFetch({});
	await assert.rejects(() => new CommertizeClient(ENV, f).call("taskMandateCreate"), RouteMissingError);
	assert.equal(calls.length, 0);
});

test("client: session route without a token is refused before the network", async () => {
	const { f, calls } = fakeFetch({});
	await assert.rejects(() => new CommertizeClient({ baseUrl: ENV.baseUrl }, f).call("deskCounts"), /COMMERTIZE_SESSION_TOKEN/);
	await assert.rejects(() => new CommertizeClient({ baseUrl: ENV.baseUrl }, f).call("partnerListings"), /COMMERTIZE_API_KEY/);
	assert.equal(calls.length, 0);
});

test("client: sends the right credential to the right route only", async () => {
	const { f, calls } = fakeFetch({ "GET /news": { body: [] }, "GET /partner/listings": { body: [] }, "GET /desk/counts": { body: {} } });
	const c = new CommertizeClient(ENV, f);
	await c.call("news");
	await c.call("partnerListings");
	await c.call("deskCounts");
	assert.equal(calls[0]!.headers.authorization, undefined);
	assert.equal(calls[0]!.headers["x-api-key"], undefined);
	assert.equal(calls[1]!.headers["x-api-key"], "k-key");
	assert.equal(calls[1]!.headers.authorization, undefined);
	assert.equal(calls[2]!.headers.authorization, "Bearer s-token");
	assert.equal(calls[2]!.headers["x-api-key"], undefined);
});

test("client: 404 on a switchable route says it may be switched off", async () => {
	const { f } = fakeFetch({});
	const e = await new CommertizeClient(ENV, f).call("principalAgents").catch((x) => x);
	assert.ok(e instanceof ApiError);
	assert.match(e.message, /switched off/);
});

test("routes table: every missing route names its pending state; no execution or payment route is listed", () => {
	for (const r of Object.values(ROUTES)) {
		if (r.status === "missing") assert.ok("pending" in r && r.pending.length > 0, r.id);
		assert.doesNotMatch(r.path, /execution|payment|invest|escrow|transfer|redeem/);
	}
});

// --- register ---------------------------------------------------------------
const BOARD = {
	schema: "commertize.work.v1",
	tasks: [
		{ task_id: "t-old", task_class: "c1", status: "open", required_kya_tier: "t0", deadline: "2000-01-01T00:00:00Z" },
		{ task_id: "t-closed", task_class: "c1", status: "closed", required_kya_tier: "t0" },
		{ task_id: "t-c2", task_class: "c2", status: "open", required_kya_tier: "t0" },
		{ task_id: "t-c1", task_class: "c1", status: "open", required_kya_tier: "t0" },
	],
};

test("register: wallet registered, mandate reported missing, first open unexpired task", async () => {
	const { f, calls } = fakeFetch({
		"POST /mandates/principal/passports": { status: 201, body: { passportId: "p1", agentAddress: ADDR } },
		"GET /work/v1/tasks": { body: BOARD },
	});
	const r = await register(new CommertizeClient(ENV, f), ADDR);
	assert.deepEqual(r.passport, { passportId: "p1", agentAddress: ADDR, reused: false });
	assert.equal(r.mandate.set, false);
	assert.equal(r.task?.taskId, "t-c2");
	assert.match(r.taskNote, /501/);
	assert.equal(JSON.parse(calls[0]!.body!).agentAddress, ADDR);
	// Never the investment mandate route.
	assert.ok(!calls.some((c) => new URL(c.url).pathname === "/mandates/principal"));
	const filtered = await register(new CommertizeClient(ENV, fakeFetch({
		"POST /mandates/principal/passports": { status: 201, body: { passportId: "p1", agentAddress: ADDR } },
		"GET /work/v1/tasks": { body: BOARD },
	}).f), ADDR, ["c1"]);
	assert.equal(filtered.task?.taskId, "t-c1");
});

test("register: re-run after a 409 reuses the active registration (retry-safe)", async () => {
	const { f, calls } = fakeFetch({
		"POST /mandates/principal/passports": { status: 409, body: { error: "conflict" } },
		"GET /mandates/principal/agents": {
			body: { agents: [
				{ passportId: "old", agentAddress: ADDR, kyaStatus: "revoked" },
				{ passportId: "p9", agentAddress: ADDR.toUpperCase().replace("0X", "0x"), kyaStatus: "active" },
			] },
		},
		"GET /work/v1/tasks": { body: { tasks: [] } },
	});
	const r = await register(new CommertizeClient(ENV, f), ADDR);
	assert.deepEqual(r.passport.passportId, "p9");
	assert.equal(r.passport.reused, true);
	assert.equal(r.task, null);
	assert.equal(calls.filter((c) => c.method === "POST").length, 1);
});

test("register: 409 with no active row, other errors, bad address and no token all fail closed", async () => {
	const only409 = fakeFetch({
		"POST /mandates/principal/passports": { status: 409, body: {} },
		"GET /mandates/principal/agents": { body: { agents: [{ passportId: "x", agentAddress: ADDR, kyaStatus: "revoked" }] } },
	});
	await assert.rejects(() => register(new CommertizeClient(ENV, only409.f), ADDR), /no active registration/);
	const e422 = fakeFetch({ "POST /mandates/principal/passports": { status: 422, body: {} } });
	await assert.rejects(() => register(new CommertizeClient(ENV, e422.f), ADDR), /answered 422/);
	const none = fakeFetch({});
	await assert.rejects(() => register(new CommertizeClient(ENV, none.f), "0x123"), /agent-address/);
	await assert.rejects(() => register(new CommertizeClient({ baseUrl: ENV.baseUrl }, none.f), ADDR), /SESSION_TOKEN/);
	assert.equal(none.calls.length, 0);
});

// --- init -------------------------------------------------------------------
test("init: copies a template with a model seam; refuses non-empty dirs and unknown names", () => {
	const base = mkdtempSync(join(tmpdir(), "kit-init-"));
	const dest = join(base, "scout");
	const files = init("sponsor-scout", dest, "0.1.0");
	assert.deepEqual(files, ["README.md", "agent.ts", "main.ts", "model.ts", "package.json"]);
	assert.match(readFileSync(join(dest, "model.ts"), "utf8"), /YOUR MODEL CALL GOES HERE/);
	const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
	assert.equal(pkg.dependencies["@commertize/agent-kit"], "0.1.0");
	assert.throws(() => init("sponsor-scout", dest, "0.1.0"), /not an empty directory/);
	const file = join(base, "f");
	writeFileSync(file, "x");
	assert.throws(() => init("desk-watcher", file, "0.1.0"), /not an empty directory/);
	assert.throws(() => init("hosted-builder", join(base, "n"), "0.1.0"), /unknown template/);
	assert.deepEqual(readdirSync(base).sort(), ["f", "scout"]);
	for (const n of readdirSync(dest)) assert.doesNotMatch(readFileSync(join(dest, n), "utf8"), /s-token|k-key/);
});

test("cli: routes lists every route; unknown command exits 2", async () => {
	const lines: string[] = [];
	assert.equal(await main(["routes"], (l) => lines.push(l), () => {}), 0);
	assert.equal(lines.length, Object.keys(ROUTES).length + 1);
	assert.equal(await main(["deploy"], () => {}, () => {}), 2);
});
