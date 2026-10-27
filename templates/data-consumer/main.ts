// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Commertize, Inc.
// One pass. Schedule it yourself if you want it to repeat; Commertize runs nothing for you.
import { runOnce } from "@commertize/agent-kit";
import { dataConsumer } from "./agent.ts";
import { model } from "./model.ts";

await runOnce(dataConsumer, model);
