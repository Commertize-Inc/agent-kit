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
