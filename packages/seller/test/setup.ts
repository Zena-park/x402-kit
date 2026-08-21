// The default replay store is process-wide on purpose (sibling paywalls must
// share claims); tests reuse fixed payment ids, so start each test clean.
import { beforeEach } from "vitest";
import { resetDefaultReplayStore } from "../src/paywall.js";

beforeEach(() => resetDefaultReplayStore());
