#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

import { parseArgs } from "node:util";
import { CommertizeClient, readEnv } from "./client.ts";
import { init, TEMPLATES } from "./init.ts";
import { register } from "./register.ts";
import { homedir } from "node:os";
import { install, installPrompt, sha256, writeSkillFiles } from "./install.ts";
import { ROUTES, ROUTES_CHECKED_AT } from "./routes.ts";

export const KIT_VERSION = "0.1.0";

const USAGE = `commertize-agent ${KIT_VERSION}

  commertize-agent init <template> [dir]     copy a template (${TEMPLATES.join(", ")})
  commertize-agent register --agent-address 0x... [--task-class c]... [--allow-host h]
                                             register your agent's wallet on Commertize and
                                             find the first open Work task
  commertize-agent install --agent-address 0x... [--allow-host h]
                                             create this agent's KYA passport; reports the agent
                                             email, wallet and mandate steps (exit 3, 19 if
                                             ~/.commertize/DISABLED is present)
  commertize-agent install --print-prompt    print the one install prompt and its sha256
  commertize-agent skills write <dir>        write the skill files and MCP manifest into an empty dir
  commertize-agent routes                   every route the kit calls, live or not yet available

Environment (read, never stored): COMMERTIZE_API_BASE_URL, COMMERTIZE_SESSION_TOKEN, COMMERTIZE_API_KEY
`;

export async function main(argv: string[], out = console.log, err = console.error): Promise<number> {
	const [cmd, ...rest] = argv;
	try {
		if (cmd === "init") {
			const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
			const [name, dir] = positionals;
			if (!name) return err(USAGE), 2;
			const files = init(name, dir ?? name, KIT_VERSION);
			out(`Created ${dir ?? name}: ${files.join(", ")}\nNext: wire your model in model.ts, then npm install && npm start.`);
			return 0;
		}
		if (cmd === "register") {
			const { values } = parseArgs({
				args: rest,
				options: { "agent-address": { type: "string" }, "task-class": { type: "string", multiple: true }, "allow-host": { type: "string" } },
			});
			const addr = values["agent-address"];
			if (!addr) return err(USAGE), 2;
			const r = await register(new CommertizeClient(readEnv(process.env, values["allow-host"], err)), addr, values["task-class"] ?? []);
			out(
				[
					`Wallet: ${r.passport.agentAddress} (${r.passport.reused ? "already registered" : "registered"}, ${r.passport.passportId})`,
					`Mandate: not set. ${r.mandate.reason}`,
					`Work: ${r.taskNote}`,
				].join("\n")
			);
			return 3; // registered, but the mandate step is not available yet
		}
		if (cmd === "install") {
			const { values } = parseArgs({
				args: rest,
				options: { "agent-address": { type: "string" }, "allow-host": { type: "string" }, "print-prompt": { type: "boolean" } },
			});
			if (values["print-prompt"]) {
				const p = installPrompt(KIT_VERSION);
				out(p.replace(/\n$/, "")); // console adds the one trailing newline, so stdout is the exact hashed bytes
				out(`sha256 ${sha256(p)}`);
				out("Verify with `shasum -a 256` against the install-prompt.sha256 on the signed release asset and the hash at commertize.com.");
				return 0;
			}
			const addr = values["agent-address"];
			if (!addr) return err(USAGE), 2;
			const r = await install({ home: homedir(), env: process.env, agentAddress: addr, allowHost: values["allow-host"], warn: err, kitVersion: KIT_VERSION });
			for (const s of r.steps) out(`${s.state.padEnd(13)} ${s.id.padEnd(8)} ${s.message}`);
			return r.exit;
		}
		if (cmd === "skills") {
			const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
			const [sub, dir] = positionals;
			if (sub !== "write" || !dir) return err(USAGE), 2;
			out(`Wrote ${dir}: ${writeSkillFiles(dir, KIT_VERSION).join(", ")}`);
			return 0;
		}
		if (cmd === "routes") {
			out(`Route status as of ${ROUTES_CHECKED_AT.date}`);
			for (const r of Object.values(ROUTES))
				out(
					`${r.status.padEnd(7)} ${r.method.padEnd(4)} ${r.path}${"switchable" in r ? "  [answers 404 while switched off]" : ""}${
						"pending" in r ? `  (${r.pending})` : ""
					}`
				);
			return 0;
		}
		err(USAGE);
		return cmd ? 2 : 0;
	} catch (e) {
		err(`commertize-agent: ${(e as Error).message}`);
		return 1;
	}
}
