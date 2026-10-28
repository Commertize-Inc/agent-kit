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
| 10 | `job watch`: the task was rejected |
| 11 | `job watch`: the task expired |
| 12 | `job watch`: the task was cancelled |
| 13 | `job watch`: the task was closed |
| 14 | `job watch`: the task left the board |
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

`events listen` and `events serve` take:

- `--type <event type>` (repeatable, exact: `work.task.changed`, ...)
- `--since <ISO 8601 time>` (events at or after it)
- `--job <taskId>` (events about that task, and snapshots listing it)

`stream.error` and `stream.stopped` always pass a filter, so a filtered
reader still sees failures and the end of the stream.

