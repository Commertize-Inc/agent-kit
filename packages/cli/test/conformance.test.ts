// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

// CAS conformance for every template: each run emits receipts that validate
// (schema, C-1, R-1, R-2), chain (R-3) and verify (C-2); every missing route
// stops with a blocked receipt and makes no network call; nothing runs on an
// unwired model.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ROUTES,
	checkSequence,
	unwiredModel,
	validateReceipt,
	verifyEd25519,
	type Template,
} from "../src/index.ts";
import { sponsorScout } from "../../../templates/sponsor-scout/agent.ts";
import { registerCleaner } from "../../../templates/register-cleaner/agent.ts";
import { dataConsumer } from "../../../templates/data-consumer/agent.ts";
import { deskWatcher } from "../../../templates/desk-watcher/agent.ts";
import { ctxFor, fakeFetch } from "./helpers.ts";

const MAIN_SHAPED = {
	"GET /listings": { body: [{ sponsor: { name: "Example Sponsor LLC" } }] },
	"GET /work/v1/tasks": {
		body: {
			schema: "commertize.work.v1",
			payouts_enabled: false,
			tasks: [
				{ task_id: "t-1", task_class: "c", status: "open", required_kya_tier: "t0", source: { dataset_key: "d", snapshot_sha256: "0".repeat(64) } },
			],
		},
	},
	"GET /partner/listings": { body: { listings: [] } },
	"GET /news": { body: { articles: [] } },
	"GET /mandates/principal/agents": {
		body: {
			nextCursor: null,
			agents: [
				{ passportId: "p1", agentAddress: "0x" + "a".repeat(40), kyaStatus: "active", mandates: [] },
				{ passportId: "p2", agentAddress: "0x" + "A".repeat(40), kyaStatus: "revoked", mandates: [] },
			],
		},
	},
	"GET /desk/counts": { body: { counts: {} } },
	"GET /agents/activity": { body: { events: [] } },
	"GET /desk/brief": { body: { news: [] } },
};

const TEMPLATES: Template[] = [sponsorScout, registerCleaner, dataConsumer, deskWatcher];

for (const t of TEMPLATES) {
	test(`${t.name}: receipts are CAS v0.1 conformant and chained`, async () => {
		const { f, calls } = fakeFetch(MAIN_SHAPED);
		const ctx = ctxFor(f);
		const res = await t.run(ctx);
		assert.ok(res.receipts.length >= 2, "at least a read and a decision");
		for (const r of res.receipts) assert.deepEqual(validateReceipt(r), [], `receipt ${r.seq}`);
		assert.equal(checkSequence(res.receipts), null);
		for (const r of res.receipts) assert.equal(verifyEd25519(r, ctx.key.keyId, ctx.key.pub), true);
		assert.ok(ctx.prompts.length >= 1, "the model seam was called");
		// Nothing a template does is a commitment.
		for (const r of res.receipts) assert.equal(r.commitment.is_commitment, false);
		// Every network call is to a live route the template declares.
		const live: string[] = t.routes.filter((id) => ROUTES[id].status === "live").map((id) => ROUTES[id].path);
		for (const c of calls) assert.ok(live.includes(new URL(c.url).pathname), `undeclared call ${c.url}`);
	});

	test(`${t.name}: each missing route stops with a blocked receipt and no network call`, async () => {
		const { f, calls } = fakeFetch(MAIN_SHAPED);
		const res = await t.run(ctxFor(f));
		const missing = t.routes.filter((id) => ROUTES[id].status === "missing");
		assert.deepEqual(res.stopped.map((s) => s.route).sort(), [...missing].sort());
		for (const id of missing) {
			const r = res.receipts.find((x) => x.blocked_check_id === `route_missing.${id}`);
			assert.ok(r, `blocked receipt for ${id}`);
			assert.equal(r.status, "blocked");
			const re = new RegExp(`^${ROUTES[id].path.replace(/:[A-Za-z]+/g, "[^/]+")}$`);
			assert.ok(!calls.some((c) => re.test(new URL(c.url).pathname)), `no call to ${ROUTES[id].path}`);
			const pending = (ROUTES[id] as { pending?: string }).pending!;
			assert.ok(res.stopped.find((s) => s.route === id)!.reason.includes(pending));
		}
	});

	test(`${t.name}: refuses to run on an unwired model`, async () => {
		const { f } = fakeFetch(MAIN_SHAPED);
		const ctx = { ...ctxFor(f), model: unwiredModel };
		await assert.rejects(() => t.run(ctx), /No model wired/);
	});

	test(`${t.name}: a live route answering an error fails the run (no silent empty state)`, async () => {
		const { f } = fakeFetch({});
		await assert.rejects(() => t.run(ctxFor(f)), /answered 404/);
	});
}

test("validator: R-1 commitment without sign-off must be awaiting_human", async () => {
	const { f } = fakeFetch(MAIN_SHAPED);
	const ctx = ctxFor(f);
	const ok = await ctx.log.record({ verb: "request_signature", objectRef: "x", evidence: 1, isCommitment: true });
	assert.equal(ok.status, "awaiting_human");
	const bad = { ...ok, status: "recorded" as const };
	assert.ok(validateReceipt(bad).some((i) => i.rule === "R-1"));
});

test("validator: R-2 blocked receipt without a check id is refused", async () => {
	const ctx = ctxFor(fakeFetch({}).f);
	const r = await ctx.log.record({ verb: "check", objectRef: "x", evidence: 1, blockedCheckId: "c1" });
	const { blocked_check_id: _drop, ...rest } = r;
	assert.ok(validateReceipt(rest).some((i) => i.rule === "R-2"));
});

test("validator: C-1 tampered field fails the hash; C-2 stale-hash signature fails", async () => {
	const ctx = ctxFor(fakeFetch({}).f);
	const r = await ctx.log.record({ verb: "read", objectRef: "x", evidence: 1 });
	const t = { ...r, action: { ...r.action, object_ref: "y" } };
	assert.ok(validateReceipt(t).some((i) => i.rule === "C-1"));
	assert.equal(verifyEd25519(t, ctx.key.keyId, ctx.key.pub), false);
	assert.equal(verifyEd25519(r, ctx.key.keyId, ctx.key.pub), true);
	assert.equal(verifyEd25519(r, ctx.key.keyId, ctxFor(fakeFetch({}).f).key.pub), false);
});

test("validator: unknown property and non-CAS verb are refused", async () => {
	const ctx = ctxFor(fakeFetch({}).f);
	const r = await ctx.log.record({ verb: "read", objectRef: "x", evidence: 1 });
	assert.ok(validateReceipt({ ...r, extra: 1 }).some((i) => i.rule === "C-0"));
	assert.ok(validateReceipt({ ...r, action: { verb: "transfer", object_ref: "x" } }).some((i) => i.path === "/action/verb"));
	await assert.rejects(() => ctx.log.record({ verb: "transfer" as never, objectRef: "x", evidence: 1 }), /receipt refused/);
});

test("sequence: R-3 broken link, reordered and mixed-mandate sequences are refused", async () => {
	const ctx = ctxFor(fakeFetch({}).f);
	const a = await ctx.log.record({ verb: "read", objectRef: "a", evidence: 1 });
	const b = await ctx.log.record({ verb: "read", objectRef: "b", evidence: 2 });
	assert.equal(checkSequence([a, b]), null);
	assert.equal(checkSequence([b, a])?.rule, "R-3");
	assert.equal(checkSequence([])?.rule, "R-3");
	const other = ctxFor(fakeFetch({}).f);
	const c = await other.log.record({ verb: "read", objectRef: "c", evidence: 3 });
	const relinked = { ...c, mandate_id: "m-2" };
	assert.notEqual(checkSequence([a, relinked]), null);
});

test("evidence with decimals (real API data) is digested; the receipt stays integer-only", async () => {
	const ctx = ctxFor(fakeFetch({}).f);
	const r = await ctx.log.record({ verb: "read", objectRef: "x", evidence: { v: 1.5 } });
	assert.deepEqual(validateReceipt(r), []);
	const s = await ctx.log.record({ verb: "read", objectRef: "x", evidence: { v: 1.6 } });
	assert.notEqual(r.evidence.sha256, s.evidence.sha256);
});
