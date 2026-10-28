# Desk Watcher

Reads the public Work board and listings plus your own Commertize Desk (counts, your agents' activity, the brief) and asks your model for a short note listing only what is waiting on a person. Delivering the note (email, chat, pager) is yours to wire. It never signs, approves or declines anything.

| Step | Route | Status (2026-10-26) |
|---|---|---|
| Work board | `GET /work/v1/tasks` | answered 404 on 2026-10-27 (built, not released); may be empty once live |
| Listings | `GET /listings` | live |
| Desk counts | `GET /desk/counts` (your session) | live; empty unless mandates are switched on |
| Your agents' activity | `GET /agents/activity` (your session) | live; empty unless mandates are switched on |
| Desk brief | `GET /desk/brief` (your session) | live |

1. Put your model call in `model.ts`.
2. Set `COMMERTIZE_SESSION_TOKEN`, `COMMERTIZE_MANDATE_ID`, `COMMERTIZE_AGENT_ID`, `COMMERTIZE_AGENT_KEY_ID`, `COMMERTIZE_AGENT_SEED`.
3. `npm install && npm start`.
