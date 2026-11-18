# @commertize/market

> **DRAFT. NOT CLEARED. NOT FOR RELEASE.** Every sentence in this file is draft
> wording pending review. The package is not published to npm, and the
> marketplace API it reads is not live yet.

<!-- R-2 DRAFT, NOT CLEARED -->
A small client for Commertize marketplace search: find services that charge per request over x402, see price, network and payee before paying, and check a receipt after.

<!-- R-3 DRAFT, NOT CLEARED -->
Search is free, keyless and read-only. Results default to Base mainnet.

<!-- R-4 DRAFT, NOT CLEARED -->
The optional pay helper uses your own wallet. It never asks for or stores a private key or seed phrase.

<!-- R-5 DRAFT, NOT CLEARED -->
It pays only after the endpoint's own payment request matches the entry, and only within the spending limit you set. A limit is required.

<!-- R-6 HELD: draft text not included here; see the pull request. -->

<!-- R-7 DRAFT, NOT CLEARED; the provenance clause is not yet true (nothing is published) -->
No telemetry. No install scripts. Published from CI with npm provenance.

<!-- R-8 HELD: draft text not included here; see the pull request. -->

## Use (draft)

```ts
import { createMarketClient } from "@commertize/market";

const market = createMarketClient(); // base URL: https://commertize.com/api/market/v1
const { results } = await market.search({ q: "weather", checksPassed: true, maxPriceUsd: "0.05" });
const endpoint = await market.getEndpoint(results[0].endpoints[0].endpoint_id);
```

Optional payment (needs the `x402` peer dependency, version 0.7.3):

```ts
import { createSpendingLimit, payEndpoint } from "@commertize/market/pay";

const limit = createSpendingLimit({ network: "base", asset: endpoint.price.asset_address, perCall: "10000", total: "50000" });
const res = await payEndpoint({ endpoint, wallet: yourSignerObject, limit });
if (res.receiptId) {
	const receipt = await market.getReceipt(res.receiptId);
	receipt.matches({ amount: res.amountAtomic, payee: res.payTo, endpoint: endpoint.endpoint_id });
}
```

Amounts are integers in the asset's smallest unit. Base Sepolia is used only when you pass `network: "base-sepolia"`.

## Install into an agent project (draft)

<!-- I-1..I-6 DRAFT, NOT CLEARED -->
One command adds Commertize Agentic Markets to your agent project:

```sh
npx @commertize/market install
```

It writes two files inside the current directory and nowhere else:

- `.mcp.json`: adds one MCP server entry named `commertize-agentic-markets`. Other entries are kept.
- `skills/commertize-market/SKILL.md`: the skill file shipped in this package.

Options: `--dir <path>` to install into another project, `--url <mcp-url>` to point at another server (https only; plain http only for localhost), `--mcp-only` to add the MCP entry alone, `--dry-run` to see what it would write.

It changes nothing and exits with code 2 if an existing entry or skill file differs, if `.mcp.json` is not valid JSON, or if a target is a symlink. It makes no network request, reads no environment variables, and never asks for a key or an account.

If your client keeps MCP servers or skills somewhere else, copy the same entry and file there.

## Licence

Apache-2.0.
