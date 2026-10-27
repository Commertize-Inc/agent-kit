#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
import { main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2));
