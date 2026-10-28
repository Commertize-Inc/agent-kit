# Commertize Agent Kit

Templates and a small CLI for running **your own** software agent against [Commertize](https://commertize.com), a digital capital markets platform for real-world assets. You run it on your own machine, with your own framework, model and keys.

What this is not: a hosted builder. Commertize runs nothing for you: no runtime, no schedule, no custody of any key. The kit contains nothing from Commertize's compliance engine and reaches no investor or holder data. Commertize does not list, operate or vouch for any agent built with it.

| Path | What it is | Licence |
|---|---|---|
| `packages/cli` | `@commertize/agent-kit` CLI (command `commertize-agent`) and library: route table, API client, CAS v0.1 receipts | Apache-2.0 |
| `templates/sponsor-scout` | Finds candidate sponsors from your sources; drafts an introduction for a person to review | Apache-2.0 |
| `templates/register-cleaner` | Data upkeep: checks the source a Work task names and prepares a change report | Apache-2.0 |
| `templates/data-consumer` | Reads free Commertize data and summarises it with citations | Apache-2.0 |
| `templates/desk-watcher` | Reads the Work board and your own Desk; prepares a note on what waits on a person | Apache-2.0 |
| prose (`*.md`) | Documentation | CC-BY-4.0 (`docs/LICENSE`) |

## Quick start

This package is not on the npm registry. Run it from a clone:

```
git clone https://github.com/Commertize-Inc/agent-kit && cd agent-kit && npm ci
alias commertize-agent="node --experimental-strip-types --conditions=source $PWD/packages/cli/src/bin.ts"
```

```bash
commertize-agent init data-consumer my-agent
cd my-agent
# put your model call in model.ts, then:
npm install && npm start
```

Each template is a short loop with one seam, `model.ts`, marked **YOUR MODEL CALL GOES HERE**. Until you wire it, the template refuses to run. Every action it takes is recorded as a CAS v0.1 receipt (Commertize Agent Standard, draft), hash-linked and signed with your agent key. The kit keeps receipts in memory and prints them; where you store them is up to you.

## Register your agent

```bash
commertize-agent register --agent-address 0xYOUR_AGENT_ADDRESS
```

This registers your agent's address under your signed-in Commertize account, reports whether a task mandate can be set, and prints the first open Commertize Work task. Run it again safely: an address already on file is reused.

## Environment

Read at run time, never written to disk, never logged, sent only to the API base you set.

| Variable | Used for |
|---|---|
| `COMMERTIZE_API_BASE_URL` | API base, default `https://api.commertize.com`. Only that host or localhost; any other host is refused unless you also pass `--allow-host <host>` (announced on stderr). Must be https (http only for localhost). |
| `COMMERTIZE_SESSION_TOKEN` | Your own signed-in session, for routes about your own account. Short-lived; copy a fresh one when it expires. |
| `COMMERTIZE_API_KEY` | Your own issued API key, for keyed routes. |
| `COMMERTIZE_MANDATE_ID`, `COMMERTIZE_AGENT_ID`, `COMMERTIZE_AGENT_KEY_ID` | Your own CAS identifiers for receipts. |
| `COMMERTIZE_AGENT_SEED` | Your agent's ed25519 seed (32 bytes, base64url) for signing receipts. Or pass your own `Signer` (hardware key, cloud key service) to `ReceiptLog`. |

## Built and live: every route the kit calls

Status as of 2026-10-26. "Live" means the route is available on the public Commertize API. Some live routes can be switched off on a deployment and then answer 404; the kit says so when that happens. A route that is Not open is never imitated: the step stops, records a blocked receipt saying so, and the command exits with code 3. `commertize-agent routes` prints this table from the code.

| Route | Used by | State |
|---|---|---|
| `POST /mandates/principal/passports` | `register` | live; may be switched off (404) |
| `GET /mandates/principal/agents` | `register` (re-run), `whoami`, `agents`, `mandate show`, `identity show` | live; may be switched off (404) |
| `GET /kya/passports/:pid/checks` | `identity show` | live; may be switched off (404) |
| `POST /agents/v1/pairings` | `register` (headless pairing) | Not open |
| `POST /agents/v1/task-mandates` | `register` | Not open |
| `GET /agents/v1/me` | `register` | Not open |
| `GET /work/v1/tasks` | `register`, register-cleaner, desk-watcher | answered 404 on 2026-10-27 (built, not released); may be empty once live |
| `POST /work/v1/tasks/:taskId/submissions` | register-cleaner | Not open: answers 501 until claims open |
| `GET /listings` | sponsor-scout, data-consumer, desk-watcher | live |
| `GET /partner/listings` | library only | live; needs an issued API key |
| `GET /news` | data-consumer | live |
| `GET /api-keys/:id/usage` | data-consumer | Not open |
| `POST /agents/submissions` | sponsor-scout | Not open |
| `GET /desk/counts` | desk-watcher | live; empty unless mandates are switched on |
| `GET /agents/activity` | desk-watcher | live; empty unless mandates are switched on |
| `GET /desk/brief` | desk-watcher | live |

## From an agent loop

Exit codes, the `hand_back` on every refusal, `availableTools` on every event line, event filters, `events drain`, `whoami`, `agents`, `mandate show` and `skill check`: see [docs/agent-loop.md](docs/agent-loop.md). The loopback event stream is `commertize-agent events serve`; the name `serve` is reserved for [your own handler as a paid endpoint](docs/serve-paid-endpoint.md), which is Not open. If every drain exits 9 after a reboot, a stale lock file is held by a process id that now belongs to something else; [docs/agent-loop.md](docs/agent-loop.md#a-lock-that-stays-busy) says how to clear it.

## Through MCP

A template's reads can also go through the Commertize MCP server ([Commertize-Inc/mcp-server](https://github.com/Commertize-Inc/mcp-server)) from any MCP client. The kit does not bundle or start that server: clone and build it, then print the client config for your template:

```bash
commertize-agent mcp desk-watcher --server /absolute/path/to/mcp-server/dist/index.js
```

The config goes to stdout. The server tools the template uses, and the server variable each one sits behind, go to stderr. Every gated tool is off on the server by default, and the printed config sets no gate and no credential. You decide what to open, on your own machine. Tools marked "in review" are not on the server's main branch.

## What a task mandate allows

Kit templates act only under CAS task verbs: `read`, `screen`, `draft`, `check`, `file`, `request_signature`, `notify`. None of them moves money or signs for anyone. Anything that would bind a person is recorded as `awaiting_human` until that person signs.

## Develop

```bash
npm install
npm run typecheck
npm test               # node:test; includes the CAS conformance test every template must pass
npm run check:wording  # the wording guard CI and the pre-push hook run
```

Requires Node 22.6 or later.

## Notices

Nothing here is an offer or solicitation of any security, or legal, tax or investment advice. Provided as-is under the licences above. "Commertize" is a trademark of Commertize, Inc.; the licences grant no trademark rights. See `NOTICE`, `SECURITY.md`.
