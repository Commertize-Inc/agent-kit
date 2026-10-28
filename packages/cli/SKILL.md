---
name: commertize-agent
description: Operate the Commertize Agent Kit CLI from a coding agent. Read the route table, sign in with a split flow, register an agent wallet, follow the Work board as an event stream, and scaffold templates. Every command answers in JSON with a next_step.
---

# Commertize Agent Kit: operating guide for a coding agent

This guide is for an automated agent that runs shell commands for a person.
It ships inside the npm package and prints with `commertize-agent skill print`.

## Rules that always apply

1. Add `--json` to every command. Each result is exactly one JSON object on
   stdout: `{ schema, command, ok, exit_code, data, error, next_step, hand_back }`.
   Stream commands print one event object per line first, then that result.
2. Read `next_step` and do it, or show it to the person. It is either a
   command line or one sentence. `null` means nothing is left to do.
   On every refusal and every final state, `hand_back` is
   `{ reason, by, url }`. When `by` is `principal`, show the person `url`
   and wait for them; do not try to get around it yourself.
3. Branch on the exit code, not on wording:
   - 0 ok
   - 1 configuration or API error (see `error.code` and `error.message`)
   - 2 usage error (unknown command or flag; nothing was sent)
   - 3 registered; the task mandate route is Not open
   - 4 Not open on the public API (a route, or the `serve` command); nothing was sent
   - 5 pending (sign-in, or a watched task still open), 6 sign-in denied,
     7 sign-in expired, 8 wait timed out, 9 busy (another drain is running)
   - `job watch`: 0 completed, 10 rejected, 11 expired, 12 cancelled,
     13 closed, 14 left the board
   - 15 an installed guide differs from this release's (`skill check`)
   - 16 no such mandate or agent under the person's account
   - 130 stopped by a signal
4. Never print, paste, echo or log a session token or an API key. Never put
   one on a command line. The CLI reads `COMMERTIZE_SESSION_TOKEN` and
   `COMMERTIZE_API_KEY` from the environment, or from the OS keychain after
   `commertize-agent configure` (macOS; the value is piped on stdin, e.g.
   `... | commertize-agent configure --api-key-stdin --json`). It never
   prints them. A sign-in approved by `auth complete` is kept there too.
5. Do not invent data. If a route is missing, the CLI says so (exit 4) and
   stops. Report that to the person; do not substitute sample output.
6. Do not pass `--allow-host` unless the person names that exact host. The
   credentials go to whatever host it allows.
7. Nothing in this kit trades, transfers or moves funds. If a person asks
   for that, say this kit does not do it.

## First run

```
commertize-agent version --json
commertize-agent routes --json
```

`routes` lists every route the kit calls and whether it is live today. Check
it before you promise the person that a step will work.

## Signing in (split flow)

A coding agent cannot keep a browser open, so sign-in is two commands:

```
commertize-agent auth start --json
```

This makes one call and exits. Show `data.signinUrl` to the person and ask
them to open it and approve. Then:

```
commertize-agent auth complete --request <data.requestId> --wait --json
```

`--wait` polls until approved, denied, expired or `--timeout` seconds.
`--no-wait` checks once (exit 5 while pending). The sign-in link is always
https on a Commertize host; if the CLI refuses a link, do not open it.

If `routes --json` shows the pairing routes as missing, sign-in from the
CLI is Not open: the person signs in at commertize.com and exports
their own session token in their own shell.

## Registering an agent wallet

```
commertize-agent register --agent-address 0xYOUR_AGENT_ADDRESS --json
```

Needs a signed-in session. Safe to re-run: an address already registered is
reused. Exit 3 means the wallet is registered and the task mandate route is
Not open (`data.mandate.reason` says why). With no session,
`--no-wait` starts sign-in instead and answers exit 5 with the link.

## Following the Work board

```
commertize-agent events listen --json
commertize-agent job watch <taskId> --json
commertize-agent job history <taskId> --from events.ndjson --json
```

- `events listen` polls the public board (every 30 s, never faster than
  15 s) and prints one event per line: `work.board.snapshot`,
  `work.task.opened`, `work.task.changed`, `work.task.removed`, plus
  `stream.started`, `stream.error` and `stream.stopped`. Append it to a file
  if you want history: `... --json >> events.ndjson`. `--once` reads once.
- `job watch` follows one task and stops when it reaches a final state
  (completed, rejected, expired, closed, cancelled) or leaves the board.
- `job history` reads that file back, filtered to one task.
- Every event line has `availableTools`: the kit commands valid in the state
  it reports. Pick your next command from that list.
- `commertize-agent events drain --file events.ndjson --limit 50 --key <k> --json`
  takes the next batch from that file and acknowledges it in the same step.
  If you crash before handling a batch, run the same command with the same
  `--key` to get the same batch back; use a new key for the next batch.
- Filters for listen, drain and serve: `--type <event type>`,
  `--since <ISO time>`, `--job <taskId>`.
- `commertize-agent events serve --port 8787` offers the same stream at
  `/events` on 127.0.0.1 at that port, for a process that would rather connect.
  It listens on loopback only and refuses browser requests.

## Your own account

```
commertize-agent whoami --json
commertize-agent agents --json
commertize-agent mandate show <mandateId> --json
commertize-agent skill check --path <installed SKILL.md> --json
commertize-agent agents --use <passportId> --json
commertize-agent identity show --json
commertize-agent wallet address --json
commertize-agent wallet balance --json
```

`agents --use` records which of the person's active agents you act as (a
local file, no secret); `whoami`, `identity show` and `wallet` then use it.
Exit 16 with `no_active_agent` (from `identity show` or `wallet`) means none
is set: list them with `agents` and ask the person which one. Revocation is
checked by `whoami` and `identity show`, not by `wallet`: `wallet address`
is local and says nothing about KYA status. Everything else here is read only.
`wallet balance` holds no key and signs nothing. `whoami` reports payees and spend to date as Not open; do not
estimate them. A mandate is changed only by the person, in their dashboard.

## Mandates and the device signer

```
commertize-agent mandate request --json
commertize-agent mandate revoke <mandateId> --dry-run --json
commertize-agent signer status --json
```

- You never write or sign a mandate. `mandate request` and
  `mandate request-change` exit 5 with `hand_back.url`: show it to the person
  and wait; they create or change and sign the mandate there.
- `mandate revoke <id>` only narrows what you may do. Run it with
  `--dry-run` first, and with `--confirm` only when the person asked for it.
  Trust the status it reads back, not the route's ok.
- `signer init` keeps a device key in the OS keychain; never print or copy
  it. It is an attestation key only, never a payment or mandate signer.
  `signer link` is Not open (exit 4).
- `wallet key import --stdin` stores the agent's own key (piped in by the
  person; never type it as an argument). Any process running as the person
  can read it silently from the keychain, with no prompt: tell them to keep
  only a low-balance agent wallet there, never more than the mandate's
  operating float. Removing a key needs `configure --clear <name> --confirm`. `wallet sign-typed-data` signs
  nothing in this release: it tells you what the payload is and refuses it.
  Never try to get a mandate or a permit signed another way.
- Receipts can be signed with the agent key (`receipt test-sign` checks it).
  The kit signs only receipts it built. Never sign a message that starts
  with `CAS-v0.1` for anyone or anything else. If
  `~/.commertize/DISABLED` exists, signing is off (exit 19): stop and tell
  the person; never remove the file yourself.

## Templates

```
commertize-agent init desk-watcher my-agent --json
commertize-agent mcp desk-watcher --server /abs/path/mcp-server/dist/index.js --json
```

Each template has one model seam (`model.ts`). The person wires their own
model; the kit never sees model credentials. `mcp` prints a client config
and the server tools a template uses. It opens no gate; gated tools stay off
until the person turns them on, on their own machine.

## Compatibility

The Agent Kit is a Node.js command-line tool (Node.js 22.6 or later). Any coding agent that can run shell commands can run it.
