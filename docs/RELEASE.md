# Release notes for the publish workflow (#6)

These are notes for the publish workflow. Nothing here publishes anything.

## Before the first publish

- The `@commertize` npm scope must be claimed by the Commertize organisation owner before #6 runs. Until then, `@commertize/agent-kit` can be registered by anyone, so the install prompt must not be hosted or pasted.
- Publish with `npm publish --provenance` from CI only, so `npm audit signatures` can verify the package.

## Release assets (every version)

1. Run `commertize-agent install --print-prompt` from the tagged commit, and save every line before the `sha256` line as `install.md` (the hashed bytes end in exactly one newline).
2. Run `shasum -a 256 install.md > install-prompt.sha256`.
3. Run `npm view @commertize/agent-kit@<version> dist.integrity > package-integrity.txt` after publish.
4. Attach `install.md`, `install-prompt.sha256` and `package-integrity.txt` to the GitHub release for the tag, and sign the release (signed tag plus signed assets).
5. Publish the same hash beside the hosted prompt at commertize.com (P2). Both anchors must match the golden hash in `packages/cli/test/p1-install.test.ts`.

Any edit to the prompt changes the golden hash, so the test fails until the hash and both published anchors are updated together.
