// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.

/**
 * Using a template through the Commertize MCP server
 * (github.com/Commertize-Inc/mcp-server) instead of direct HTTP calls.
 *
 * The kit does not bundle, start or download that server. You build it from
 * its repository and point your MCP client at the built entry file; this
 * module only writes the client config block and says which server tools
 * each template uses and which server gate each tool sits behind.
 *
 * The kit never opens a gate for you. Every gated tool is off on the server
 * by default, and the config written here sets no gate and no credential:
 * you add what you decide to open, on your own machine.
 */

import { isAbsolute } from "node:path";
import { KitConfigError } from "./client.ts";
import { TEMPLATES, type TemplateName } from "./init.ts";

export const MCP_TOOLS_CHECKED_AT = { date: "2026-10-27" } as const;

export interface McpTool {
	name: string;
	/** Server environment variable that must be exactly "1" for the tool to be listed; null = always listed. */
	gate: string | null;
	/** "main": on the server's main branch. "in-review": in an open pull request on the server. */
	availability: "main" | "in-review";
}

const T = (name: string, gate: string | null, availability: McpTool["availability"] = "main"): McpTool => ({
	name,
	gate,
	availability,
});

const OFFERINGS = "COMMERTIZE_MCP_ENABLE_OFFERINGS";
const PLATFORM = "COMMERTIZE_MCP_ENABLE_PLATFORM_READS";
const X402 = "COMMERTIZE_MCP_ENABLE_X402";
const SUBMISSIONS = "COMMERTIZE_MCP_ENABLE_SUBMISSIONS";

/** Server tools each template uses. Every template appears exactly once. */
export const TEMPLATE_MCP_TOOLS: Record<TemplateName, readonly McpTool[]> = {
	"desk-watcher": [T("list_work_tasks", PLATFORM, "in-review"), T("list_offerings", OFFERINGS), T("get_news", null)],
	"register-cleaner": [T("list_work_tasks", PLATFORM, "in-review")],
	"data-consumer": [
		T("get_news", null),
		T("list_offerings", OFFERINGS),
		T("x402_catalog", X402),
		T("x402_terms", X402),
		T("x402_quote", X402),
		T("x402_fetch", X402),
	],
	"sponsor-scout": [
		T("search_offerings", OFFERINGS),
		T("list_sponsors", OFFERINGS),
		T("submit_asset", SUBMISSIONS, "in-review"),
		T("get_submission_status", SUBMISSIONS, "in-review"),
	],
};

export interface McpClientConfig {
	mcpServers: { commertize: { command: "node"; args: [string]; env: Record<string, never> } };
}

/**
 * The client config block for one template. `serverEntry` is the absolute
 * path of the MCP server's built `dist/index.js` on your machine.
 */
export function mcpClientConfig(template: string, serverEntry: string): { config: McpClientConfig; tools: readonly McpTool[] } {
	if (!(TEMPLATES as readonly string[]).includes(template))
		throw new KitConfigError(`unknown template "${template}". Choose one of: ${TEMPLATES.join(", ")}`);
	const entry = serverEntry.trim();
	if (!isAbsolute(entry) || !entry.endsWith(".js"))
		throw new KitConfigError("--server must be the absolute path of the MCP server's built dist/index.js");
	return {
		config: { mcpServers: { commertize: { command: "node", args: [entry], env: {} } } },
		tools: TEMPLATE_MCP_TOOLS[template as TemplateName],
	};
}
