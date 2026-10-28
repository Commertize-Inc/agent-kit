#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { main } from "./cli.ts";
import { osKeychain } from "./keychain.ts";

// The only place the real OS keychain is wired in.
process.exitCode = await main(process.argv.slice(2), console.log, console.error, { keychain: osKeychain() });
