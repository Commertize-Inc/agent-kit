// Wording guard for everything this repository publishes.
// 1. Phrases a public reader must never see from us.
// 2. Spec-only terms: CAS carries no fee, price, value or rating concepts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "__pycache__", ".pytest_cache", "build", ".venv"]);
const SKIP_FILES = new Set(["LICENSE", "pnpm-lock.yaml", "package-lock.json", "check-wording.mjs"]);
const TEXT = /\.(md|json|ts|mjs|js|py|toml|ya?ml|txt|sh)$/;

const PHRASES = [
	/coming soon/i,
	/verified by commertize/i,
	/commertize[- ]verified/i,
	/\bcertified\b/i,
	/\bcertification\b/i,
	/tamper[- ]?(evident|proof)/i,
	/\bguarantee[sd]?\b/i,
	// Agent Kit additions (2026-10-26): no performance or capital-raising language,
	// and no model/framework vendor names in kit copy (other restricted names: private pre-push check).
	/\byields?\b/i,
	/\bapy\b/i,
	/\bapr\b/i,
	/token launch/i,
	/\braise[sd]?\b/i,
	/\braising\b/i,
	/\breturns? (on|of)\b/i,
	/\b(annual|expected|projected|target|historical|high|strong) returns?\b/i,
	/passive income/i,
	/\b(openai|anthropic|claude|chatgpt|gpt-?\d|gemini|mistral|llama|langchain|langgraph|crewai|autogen|llamaindex|vercel ai)\b/i,
];
const SPEC_TERMS = /\b(fees?|pric(e|es|ing)|payouts?|royalt(y|ies)|stak(e|ing)|rewards?|points|yields?|returns|accredit(ed|ation)|rankings?|ratings?|scores?|apy|apr)\b/i;

const files = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (TEXT.test(name) && !SKIP_FILES.has(name)) files.push(p);
	}
};
walk(ROOT);

const problems = [];
for (const f of files) {
	const rel = relative(ROOT, f);
	const lines = readFileSync(f, "utf8").split("\n");
	lines.forEach((line, i) => {
		for (const re of PHRASES) if (re.test(line)) problems.push(`${rel}:${i + 1}: phrase ${re}`);
		if (rel.startsWith("spec/") && SPEC_TERMS.test(line)) problems.push(`${rel}:${i + 1}: spec term "${line.match(SPEC_TERMS)[0]}"`);
	});
}
if (problems.length) {
	console.error(problems.join("\n"));
	console.error(`check-wording: ${problems.length} problem(s) in ${files.length} files`);
	process.exit(1);
}
console.log(`check-wording: ok (${files.length} files)`);
