# Running the kit from an agent loop

Everything here is about `--json` output. Each command prints exactly one
result object on stdout (stream commands print event lines first):

```
{ schema, command, ok, exit_code, data, error, next_step, hand_back }
```

## Exit codes

Branch on the exit code, never on wording. One table for every command:

| Code | Meaning |
|---|---|
| 0 | ok (for `job watch`: the task completed) |
| 1 | configuration or API error (`error.code`, `hand_back.reason` say which) |
| 2 | usage error: unknown command or flag, bad value; nothing was sent |
| 3 | `register`: wallet registered; the task mandate route is Not open |
| 4 | Not open: the route (or the `serve` command) is not open; nothing was sent |
| 5 | pending: sign-in pending, or `job watch --once` on a task that is still open |
| 6 | sign-in denied |
| 7 | sign-in expired |
| 8 | wait timed out |
| 9 | busy: another `events drain` holds this consumer's lock |
| 10 | `job watch`: the task was rejected |
| 11 | `job watch`: the task expired |
| 12 | `job watch`: the task was cancelled |
| 13 | `job watch`: the task was closed |
| 14 | `job watch`: the task left the board |
| 15 | `skill check`: an installed guide differs from this release's, or is missing |
| 16 | not found: no such mandate or agent under your account |
| 17-20 | reserved (mandate refused, state unreadable, frozen, upstream unavailable); no command returns them in this release |
| 130 | stopped by a signal (Ctrl-C) |

## hand_back

Every refusal (any non-zero exit) and every final state carries
`hand_back: { reason, by, url }`:

- `reason` is a stable code (`session_missing`, `mandate_not_found`,
  `task_rejected`, `skill_drift`, ...).
- `by` is who acts next: `principal` (the person the agent works for) or
  `agent`.
- `url` is where. For `principal` it is a page in that person's Commertize
  dashboard (app.commertize.com); for `agent` it is this documentation.

The URL comes from a fixed table in the kit, never from a server answer. A
hand-back never names a command. Anything that grants access (signing in, a
mandate, an API key, trusting another API host) is handed to the principal;
the agent shows them the URL and waits.

## Event lines

`events listen --json`, `job watch --json` and `events serve` emit one event
object per line:

```
{ schema, seq, ts, type, data, availableTools, hand_back? }
```

- `availableTools` is the exact set of kit commands valid in the state that
  line reports. An open task: `["job watch", "job history"]`. A task in a
  final state or off the board: `["job history"]`. A snapshot: the union over
  its tasks. `stream.started` and `stream.error`: `["routes"]`.
- A line that ends something (a task reaching completed, rejected, expired,
  cancelled or closed; a task leaving the board; `stream.stopped`) also
  carries `hand_back`.

## Filters

`events listen`, `events drain` and `events serve` take:

- `--type <event type>` (repeatable, exact: `work.task.changed`, ...)
- `--since <ISO 8601 time>` (events at or after it)
- `--job <taskId>` (events about that task, and snapshots listing it)

`stream.error` and `stream.stopped` always pass a filter, so a filtered
reader still sees failures and the end of the stream.

## events drain

```
commertize-agent events listen --json >> events.ndjson     # one process writes
commertize-agent events drain --file events.ndjson --limit 50 --key b-0001 --json
```

A drain returns the next batch of complete lines and acknowledges it in the
same step: the next drain starts after it. Two drains of the same consumer
take turns; a second one while the first runs exits 9.

Retry with the same `--key` and you get the same batch again, unchanged, and
nothing moves. Use a new key once you have handled a batch. Without a key a
drain is at most once.

Each `--consumer <name>` (default `default`) has its own cursor, stored next
to the file as `<file>.<consumer>.cursor`. Events your filters exclude are
acknowledged for that consumer, so use one consumer name per filter set. If
the file is truncated or replaced, the drain refuses (exit 1,
`drain_source_changed`) instead of guessing; start a new consumer name.

### A lock that stays busy

While a drain runs it holds `<file>.<consumer>.cursor.lock`, which contains
its process id. A lock left by a drain that died is taken over automatically
when that process id no longer exists. After a reboot, the same number can
belong to an unrelated live process, and then every drain exits 9. The kit
does not guess in that case. To clear it:

1. Make sure no `events drain` for that file and consumer is running
   (`ps -p $(cat events.ndjson.default.cursor.lock)` shows what holds the id).
2. Delete the lock file: `rm events.ndjson.default.cursor.lock`.

The cursor itself is untouched, so the next drain continues where the last
acknowledged batch ended.


## whoami, agents, mandate show

- `whoami [--agent 0x...] [--receipts file.ndjson]`: one read. Your company
  check (`label` is "KYB verified" or "Reviewed by Commertize" only when the
  API serves that state with a date, otherwise none), your agent and its
  mandates, which credentials are present (environment, keychain or absent,
  never the value), and the valid receipts in a local log you name. Payees
  and spend to date have no public route and say "Not open".
- `agents [--limit n] [--cursor id]`: the agents under your account, a page
  at a time.
- `mandate show <mandateId>`: one mandate, read only. Changing a mandate is
  the principal's step, in the dashboard.

## skill check

```
commertize-agent skill check --path ./SKILL.md --json
```

Compares each installed copy of the operating guide with the guide shipped
in this release (SHA-256 of the exact bytes). Exit 15 if any copy differs or
is missing; replace it with the output of `commertize-agent skill print`.

## Active agent, identity and wallet

```
commertize-agent agents --use <passportId or 0x address> [--profile name] [--dry-run] --json
commertize-agent identity show [--agent 0x...|passportId] --json
commertize-agent wallet address --json
commertize-agent wallet balance [--network base|base-sepolia] [--token USDC|ETH] --json
```

- `agents --use` checks that the agent is one of yours and that its KYA
  status is `active`, then records it as the agent later commands act as, in
  `~/.commertize/profiles/<profile>.json` (directories 0700, file 0600). The
  file holds the passport id and address only: no credential, no key.
  `--dry-run` shows what it would record and writes nothing. A profile file
  this kit did not write, or a symlinked directory or file on that path,
  stops the command instead of being followed.
- `whoami`, `identity show` and `wallet` use the active agent when you pass
  no `--agent`. With neither, `identity show` and `wallet` exit 16
  (`hand_back.reason: "no_active_agent"`) before any network call. `whoami`
  still exits 0: it makes its one list call and shows `agent: null` unless
  your account has exactly one agent.
- `wallet address` is local: it prints the address recorded by `agents --use`
  (or the one you pass) and makes no network call, so it carries no KYA
  status. Revocation is checked by `whoami` and `identity show`, which read
  the server every time; `wallet` does not check it.
- `identity show` reads the agent's passport and its KYA check record. Every
  check row is shown, including a failed one; a row without a result makes
  the command refuse (exit 1) rather than hide it. If the check record
  answers 404 (not available for this passport on this deployment), `checks`
  is `null` with a note: it is never reported as an empty list.
- `wallet balance` reads Base over the public RPC endpoints
  (mainnet.base.org, sepolia.base.org). It checks the chain id before any
  balance read, uses the pinned USDC contract for the network, and reports
  `raw` (integer base units), `decimals` and `formatted` (built with integer
  arithmetic). It holds no key and signs nothing.

## Mandates and the device signer

```
commertize-agent mandate request --json            # exit 5: the person creates and signs it
commertize-agent mandate request-change --json     # exit 5: the person changes and signs it
commertize-agent mandate revoke <mandateId> --dry-run --json
commertize-agent mandate revoke <mandateId> --confirm --json
commertize-agent signer init --json
commertize-agent signer status --json
commertize-agent signer link --json                # exit 4: Not open
```

- The kit never writes, changes or signs a mandate. `mandate request` and
  `mandate request-change` send nothing: they exit 5 with a hand-back to the
  person's dashboard (`/mandates/new` or `/mandates`), where they create or
  change the mandate and sign it themselves. Then check with `whoami`.
- `mandate revoke` ends one of the person's mandates (POST
  /mandates/principal/:mid/revoke). Revoking only narrows what an agent may
  do. It needs `--confirm`; `--dry-run` reads the mandate and sends nothing.
  The route answers ok even when nothing changed, so the kit reads the
  mandate back and reports the status it reads: if the mandate still reads
  as live, the command fails (exit 1) and claims nothing. A mandate that had
  already ended is reported as such and nothing is sent.
- `signer init` creates a P-256 device key and keeps the private half in the
  OS keychain (macOS; it is never written to a file and never printed). It
  never replaces a stored key, even when two inits race (the keychain
  refuses the second create): remove one with
  `commertize-agent configure --clear COMMERTIZE_SIGNER_KEY`. If the
  keychain is locked or does not answer, the command stops instead of
  treating the key as absent. The key is exportable software key material,
  not a hardware key, and any process running as you can read it silently.
  While it is software-only it is an attestation key only: it never signs a
  payment, a transfer or a mandate.
- `signer link` (binding the device key to your agent) needs the pairing
  routes, which are Not open: it exits 4 before any network call. It stays
  Not open until the server offers pairing and also requires the person to
  re-link after a key rotation.

## The agent key

```
... | commertize-agent wallet key import --stdin --json
commertize-agent wallet key status --json
commertize-agent wallet sign-typed-data --file typed-data.json --json   # exit 4: nothing is signed
```

- The agent key is the secp256k1 key whose address you registered as your
  agent. You hold it: Commertize never generates, receives, keeps, recovers
  or co-signs it.
- `wallet key import` reads the key (`0x` + 64 hex) from stdin only, never
  from an argument or the environment, checks it is a valid secp256k1 key,
  derives its address, and stores it create-only in the OS keychain (an
  existing key is never replaced). If an active agent is set
  (`agents --use`), the key's address must be that agent's, or nothing is
  stored. The key is never printed; `wallet key status` shows its address.
  Remove it with
  `commertize-agent configure --clear COMMERTIZE_AGENT_KEY --confirm`
  (removing a key, this one or the signer key, needs `--confirm`).
- **Read this before importing.** Any process running as you can read the
  stored agent key from the OS keychain silently, with no prompt. Keep only
  a low-balance agent wallet there: the key must never control more than
  the mandate's operating float. `wallet key import` prints this warning on
  stderr every time.
- This release signs nothing with the agent key. `wallet sign-typed-data`
  reads the payload, says what it is, and refuses it (exit 4, `signed:
  false`), without reading the key:
  - "CAS Mandate" typed data is signed by the person you act for, never by
    the agent: `hand_back.reason: "mandate_request"`, to their dashboard;
  - Permit2 and EIP-2612 permits move value, and payments are Not open:
    `payments_not_open`;
  - anything else is not on the list the agent key may sign, which is
    empty in this release: `typed_data_not_allowlisted`.
- CAS receipts are not typed data: they are signed over `"CAS-v0.1\n"` +
  the record hash, as below.

## Receipts signed with the agent key

```
commertize-agent receipt test-sign --json
COMMERTIZE_RECEIPT_SIGNER=agent-key  (when running a template)
```

- The kit signs CAS receipts with the agent key as CAS-1 section 5.1.1
  defines: the message `"CAS-v0.1\n"` + the receipt hash (80 bytes), its
  EIP-191 digest, a 65-byte `r || s || v` signature (low `s`, `v` 27 or 28,
  RFC 6979 nonce), `alg: "secp256k1"`, and `key_id` = the agent address in
  lowercase. It reproduces every valid conformance vector of
  Commertize-Inc/cas-spec byte for byte.
- The receipt log signs only hashes it computed: it builds the record,
  computes its hash, and only then signs, and its signer is a private
  field that no caller can reach. No exported command or library function
  signs a hash, a message or typed data handed to it. This is not a key
  boundary: under the same-user model the raw key stays reachable
  in-process (and by any process running as you) through the OS keychain.
  Every signature is checked by recovering its signer before it is used.
- `receipt test-sign` signs one self-test receipt and shows that it
  recovers to the key's address. Templates sign with the agent key when
  `COMMERTIZE_RECEIPT_SIGNER=agent-key` is set; the default stays ed25519
  with `COMMERTIZE_AGENT_SEED`.
- **Signing is off by default.** The first time the kit sets up
  `~/.commertize` (`configure`, a template run, `receipt test-sign`) it
  creates `~/.commertize/DISABLED`. The person turns signing on with
  `commertize-agent receipt enable-signing --confirm`; anyone can turn it
  off again with `receipt disable-signing`. An agent never enables it.
- **Kill switch.** While `~/.commertize/DISABLED` exists, or its state
  cannot be read, the kit signs nothing with either key (ed25519 or the
  agent key) and sends no write (non-GET) call: `receipt test-sign` exits
  19 (`hand_back.reason: "disabled"`, with the enable command for the
  person), a template run stops before it starts, and a running template
  stops at its next signature or write. It is checked at run start (both
  modes), before the keychain is read, before every signature and before
  every write call.
- **What it gates.** The kill file gates signing and template runs,
  including every write a template sends. It does not gate the CLI's
  own commands that send a write: `register` (registration and pairing
  setup) still sends its write with the kill file present, and
  `mandate revoke` is left ungated on purpose, because revoking is itself
  a stop and must always work.
- **Upgrading.** Existing ed25519 template users: after this release a
  run stops with exit 19 until the person runs
  `commertize-agent receipt enable-signing --confirm` once on that machine.
- **The kill file is a cooperative stop.** It stops this kit; it cannot
  stop other code running as you. The real stop for an agent is on the
  server side: freeze its credential or account, or revoke its mandate.

## Anchoring and write routes (planned, not in this release)

- `CAS_ANCHOR_V1` is pinned to `null` today: there is no anchor contract,
  so no receipt carries an anchor and none can be anchored.
- Planned: batch anchoring of receipt hashes every 24 hours or every 500
  receipts, whichever comes first. The cadence is a working figure; it has
  not been checked against gas cost.
- Planned rule for write routes when they open: the kit records and signs
  the receipt before it sends the write, and sends the write with an
  idempotency key derived from that receipt, so a retry cannot apply twice.
- **Phishing.** A signature over `"CAS-v0.1\n"` + a hash is a valid receipt
  for whatever record has that hash. Configure the wallet or signer that
  holds the agent key to refuse any message that starts with `CAS-v0.1`
  unless the kit asks, and never sign such a message for anyone else: a
  signature obtained that way is a valid receipt for an attacker's record.
