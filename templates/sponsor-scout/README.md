# Sponsor Scout

Reads the public Commertize listings feed, asks your model to name one real-asset sponsor not already listed (with a primary source for each fact), and drafts an introduction for a person on your side to review. It contacts no one.

| Step | Route | Status (2026-10-26) |
|---|---|---|
| Read listed sponsors | `GET /listings` | live; no key needed |
| File the candidate for sponsor review | `POST /agents/submissions` (your API key) | not yet available on the public API; the step stops with a blocked receipt |

1. Put your model call in `model.ts`.
2. Set `COMMERTIZE_API_KEY`, `COMMERTIZE_MANDATE_ID`, `COMMERTIZE_AGENT_ID`, `COMMERTIZE_AGENT_KEY_ID`, `COMMERTIZE_AGENT_SEED` in your environment.
3. `npm install && npm start`. Exit code 3 means a step stopped on a route that is not yet available on the public API.

Every action is recorded as a CAS v0.1 receipt in the printed output (specification: https://github.com/Commertize-Inc/cas-spec). Store them where you choose.
