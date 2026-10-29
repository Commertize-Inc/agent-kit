---
name: commertize-agent-kit
description: Install the Commertize Agent Kit and create a KYA passport for this agent.
---

# Commertize Agent Kit

Install the Commertize Agent Kit and create a KYA passport for this agent. Do the steps in order.

1. Check for the kill file `~/.commertize/DISABLED`. If it exists, stop and tell your principal. Never remove ~/.commertize/DISABLED yourself.
2. Use only the API at https://api.commertize.com. If `COMMERTIZE_API_BASE_URL` names any other host, stop and ask your principal.
3. Read `COMMERTIZE_SESSION_TOKEN` from the environment your principal set. Never ask for it in chat, never print it, never write it to a file.
4. Install exactly `@commertize/agent-kit@0.1.0`: `npm install -g @commertize/agent-kit@0.1.0`. Refuse any other package name.
5. Run `commertize-agent install --agent-address <your agent's 0x address>`. It creates your KYA passport (or reuses it) and reports each step.
6. Exit 3 means the passport is done and the remaining steps (agent email, wallet, mandate) are not available in this kit version. Report them to your principal as written. Wallet creation always stops for the principal's passkey.
7. Exit 19 means the kill file is present: stop.
