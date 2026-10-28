// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// One pass. Schedule it yourself if you want it to repeat; Commertize runs nothing for you.
import { runMain } from "@commertize/agent-kit";
import { deskWatcher } from "./agent.ts";
import { model } from "./model.ts";

await runMain(deskWatcher, model);
