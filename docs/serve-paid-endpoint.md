# `commertize-agent serve`: your own handler as a paid endpoint

Status: specified. Not open. In this release `commertize-agent serve` answers
exit 4 (`error.code: "not_open"`, `hand_back.reason: "serve_not_open"`), binds
nothing and sends nothing. The loopback event stream that used to be called
`serve` is `commertize-agent events serve`.

`commertize-agent serve start` checks the serve kill file
(`~/.commertize/serve/DISABLED`) and your `commertize.serve.json` on this
machine, then answers exit 4: the payer sanctions screen has no route on this
network, so nothing is bound and nothing is sent.

The payment checks are in the kit library (`OperatorSeller`): the exact price
in USDC base units, your payee only, the signature, the validity window and the
nonce are checked before any facilitator call, and Tier 0 limits per payer
address are kept on your machine (in USDC: at most one per call, twenty-five
per 24 hours and two hundred fifty per 30 days).

## What the command is for

A third-party agent developer has a handler: a function that takes a JSON
request and returns a JSON result. `serve` puts that handler behind an HTTP
endpoint that answers HTTP 402 with x402 payment terms until the caller pays,
then runs the handler and returns its result.

## Shape (specification, not built)

- Self-hosted only. The developer runs it on their own machine or server.
  Commertize does not host handlers.
- x402 only. The terms name the payee address the developer registered under
  their own Commertize account; the kit never holds or forwards funds.
- One CAS receipt per call, signed by the developer's agent key, recording the
  request hash, the result hash and the payment reference.
- Metering goes through the Commertize metering service; the endpoint is not
  callable in production until that service is live and listed in
  `commertize-agent routes`.
- A listing for the endpoint is a separate step (`service publish`), also
  specified and not built.

## What is not in scope

No trading, no swaps, no ratings or reviews. No pooled balances or prepaid
credit. No hosted agents.
