# Data Consumer

Reads free Commertize listings and articles and asks your model for the summary you want, each sentence citing the record it came from.

| Step | Route | Status (2026-10-26) |
|---|---|---|
| Read listings | `GET /listings` | live; no key needed |
| Read articles | `GET /news` | live |
| Read your key's usage | `GET /api-keys/:id/usage` | Not open; the step stops with a blocked receipt |

1. Put your model call in `model.ts`.
2. Set `COMMERTIZE_MANDATE_ID`, `COMMERTIZE_AGENT_ID`, `COMMERTIZE_AGENT_KEY_ID`, `COMMERTIZE_AGENT_SEED`.
3. `npm install && npm start`.
