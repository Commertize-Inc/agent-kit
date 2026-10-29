// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * `install`: the one-prompt install. A coding agent pastes one prompt, which
 * installs this kit at a pinned version and runs `commertize-agent install`.
 *
 * Order (fail-closed, matches the kill-file rule of the signer PRs):
 *   1. kill file  ~/.commertize/DISABLED present -> stop, exit 19, nothing read, nothing sent
 *   2. host allow-list (readEnv): only api.commertize.com or loopback unless --allow-host
 *   3. credentials: COMMERTIZE_SESSION_TOKEN from the environment (never stored, never printed)
 *   4. passport: register the agent address under the principal's account (409 -> reuse)
 *   5. email, wallet, mandate: not available in this kit version, reported as such, exit 3
 *
 * The skill files are generated from one source here, so every runtime reads
 * the same steps. They hold env var names only, never a value.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { CommertizeClient, KitConfigError, readEnv, type Fetch } from "./client.ts";
import { ADDRESS, ensurePassport, type RegisterOutcome } from "./register.ts";
import { ROUTES } from "./routes.ts";

export const PACKAGE = "@commertize/agent-kit";
export const BIN = "commertize-agent";
export const INSTALL_EXIT = { ok: 0, principalStep: 3, disabled: 19 } as const;

export const killFilePath = (home: string) => join(home, ".commertize", "DISABLED");

export type StepState = "done" | "not_available" | "stopped";
export interface InstallStep {
	id: "kit" | "passport" | "email" | "wallet" | "mandate";
	state: StepState;
	message: string;
}
export interface InstallResult {
	exit: number;
	steps: InstallStep[];
	passport?: RegisterOutcome["passport"];
}

const NOT_AVAILABLE = {
	email: "Not available in this kit version: there is no agent email command in it, so no address was made.",
	wallet:
		"Not available in this kit version: there is no wallet create command in it, so no wallet was made. " +
		"Wallet creation always stops for the principal's passkey; the agent never authorises its own wallet.",
	mandate: "Not available in this kit version: there is no mandate link to print. Only the principal sets a mandate.",
} as const;

export interface InstallOptions {
	home: string;
	env: Record<string, string | undefined>;
	agentAddress: string;
	allowHost?: string;
	fetchImpl?: Fetch;
	warn?: (m: string) => void;
	/** Tests only: a client built against a fake base. */
	clientOverride?: CommertizeClient;
	kitVersion?: string;
}

export async function install(o: InstallOptions): Promise<InstallResult> {
	const version = o.kitVersion ?? "";
	const kit: InstallStep = { id: "kit", state: "done", message: version ? `Agent Kit ${version} is installed.` : "Agent Kit is installed." };
	const rest = (passport: InstallStep): InstallStep[] => [
		kit,
		passport,
		{ id: "email", state: "not_available", message: NOT_AVAILABLE.email },
		{ id: "wallet", state: "not_available", message: NOT_AVAILABLE.wallet },
		{ id: "mandate", state: "not_available", message: NOT_AVAILABLE.mandate },
	];
	// 1. kill file, before anything else is read or sent
	if (existsSync(killFilePath(o.home)))
		return {
			exit: INSTALL_EXIT.disabled,
			steps: rest({
				id: "passport",
				state: "stopped",
				message: `Stopped: ${killFilePath(o.home)} is present, so this kit makes no writes. Only your principal removes it.`,
			}),
		};
	// 2. host allow-list
	const env = readEnv(o.env, o.allowHost, o.warn);
	// 3. credentials
	if (!env.sessionToken) throw new KitConfigError("install needs COMMERTIZE_SESSION_TOKEN in the environment (your principal's session)");
	if (!ADDRESS.test(o.agentAddress)) throw new KitConfigError("--agent-address must be a 0x-prefixed 20-byte address");
	// 4. passport
	const client = o.clientOverride ?? new CommertizeClient(env, o.fetchImpl);
	const passport = await ensurePassport(client, o.agentAddress);
	return {
		exit: INSTALL_EXIT.principalStep,
		passport,
		steps: rest({
			id: "passport",
			state: "done",
			message: `Passport ${passport.passportId} for ${passport.agentAddress} (${passport.reused ? "already registered, reused" : "created"}).`,
		}),
	};
}

// --- one source for the prompt and every skill file -----------------------------

const SECRET_ENV = ["COMMERTIZE_SESSION_TOKEN", "COMMERTIZE_API_KEY"] as const;

function steps(version: string): string[] {
	return [
		`Check for the kill file \`~/.commertize/DISABLED\`. If it exists, stop and tell your principal. Never remove ~/.commertize/DISABLED yourself.`,
		`Use only the API at https://api.commertize.com. If \`COMMERTIZE_API_BASE_URL\` names any other host, stop and ask your principal.`,
		`Read \`COMMERTIZE_SESSION_TOKEN\` from the environment your principal set. Never ask for it in chat, never print it, never write it to a file.`,
		`Install exactly \`${PACKAGE}@${version}\`: \`npm install -g ${PACKAGE}@${version}\`. Refuse any other package name.`,
		`Run \`${BIN} install --agent-address <your agent's 0x address>\`. It creates your KYA passport (or reuses it) and reports each step.`,
		`Exit 3 means the passport is done and the remaining steps (agent email, wallet, mandate) are not available in this kit version. Report them to your principal as written. Wallet creation always stops for the principal's passkey.`,
		`Exit 19 means the kill file is present: stop.`,
	];
}

/** The one pasteable prompt. Hosted with its SHA-256 beside it. */
export function installPrompt(version: string): string {
	return [
		`Install the Commertize Agent Kit in your coding agent (works in any MCP-capable runtime).`,
		``,
		...steps(version).map((s, i) => `${i + 1}. ${s}`),
		``,
	].join("\n");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const TOOLS = [
	{ name: "commertize.install", cli: `${BIN} install`, route: ROUTES.passportCreate.path, available: true },
	{ name: "commertize.passport.create", cli: `${BIN} register`, route: ROUTES.passportCreate.path, available: true },
	{ name: "commertize.email.create", cli: null, route: null, available: false },
	{ name: "commertize.wallet.create", cli: null, route: null, available: false },
] as const;

export const SKILL_FILE_PATHS = ["skill/SKILL.md", "agents/AGENTS.md", "action/openapi.json", "llms.txt", "mcp.json"] as const;

export function renderSkillFiles(version: string): Record<string, string> {
	const numbered = steps(version).map((s, i) => `${i + 1}. ${s}`).join("\n");
	const desc = "Install the Commertize Agent Kit and create a KYA passport for this agent.";
	const skill = `---\nname: commertize-agent-kit\ndescription: ${desc}\n---\n\n# Commertize Agent Kit\n\n${desc} Do the steps in order.\n\n${numbered}\n`;
	const agents = `# Commertize Agent Kit\n\n${desc}\n\n## Steps\n\n${numbered}\n\n## Rules\n\n- Credentials come from the environment only: ${SECRET_ENV.join(", ")}.\n- Never remove ~/.commertize/DISABLED.\n- Never sign or approve for the principal.\n`;
	const llms = `# Commertize Agent Kit\n\n> ${desc}\n\nPackage: ${PACKAGE}@${version}\nAPI: https://api.commertize.com\n\n${numbered}\n`;
	const mcp = {
		name: "com.commertize/agent-kit",
		description: desc,
		version,
		packages: [
			{
				registryType: "npm",
				identifier: PACKAGE,
				version,
				environmentVariables: SECRET_ENV.map((name) => ({ name, isSecret: true, isRequired: name === "COMMERTIZE_SESSION_TOKEN" })),
			},
		],
		tools: TOOLS.map((t) => ({ name: t.name, cli: t.cli, route: t.route, available: t.available })),
	};
	const api = {
		openapi: "3.1.0",
		info: { title: "Commertize Agent Kit", version, description: desc },
		servers: [{ url: "https://api.commertize.com" }],
		components: { securitySchemes: { session: { type: "http", scheme: "bearer" } } },
		security: [{ session: [] }],
		paths: {
			[ROUTES.passportCreate.path]: {
				post: {
					operationId: "passportCreate",
					summary: ROUTES.passportCreate.note,
					requestBody: {
						required: true,
						content: { "application/json": { schema: { type: "object", required: ["agentAddress"], properties: { agentAddress: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } } } } },
					},
					responses: { "201": { description: "Passport created" }, "409": { description: "Address already registered" } },
				},
			},
			[ROUTES.principalAgents.path]: {
				get: { operationId: "principalAgents", summary: ROUTES.principalAgents.note, responses: { "200": { description: "Agents under your account" } } },
			},
		},
	};
	return {
		"skill/SKILL.md": skill,
		"agents/AGENTS.md": agents,
		"action/openapi.json": JSON.stringify(api, null, "\t") + "\n",
		"llms.txt": llms,
		"mcp.json": JSON.stringify(mcp, null, "\t") + "\n",
	};
}

/** Writes the skill files into `target`, which must not exist or be empty. Never overwrites. */
export function writeSkillFiles(target: string, version: string): string[] {
	const dest = resolve(target);
	if (existsSync(dest) && (lstatSync(dest).isSymbolicLink() || !lstatSync(dest).isDirectory() || readdirSync(dest).length > 0))
		throw new KitConfigError(`${dest} exists and is not an empty directory; nothing written`);
	const files = renderSkillFiles(version);
	for (const [p, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dest, p)), { recursive: true });
		writeFileSync(join(dest, p), body, { flag: "wx" });
	}
	return Object.keys(files).sort();
}
