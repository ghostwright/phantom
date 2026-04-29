// Phase 5b: shared structural type for the two Slack channel implementations.
// Code that doesn't care which transport is in use (the scheduler delivery
// paths, the /trigger endpoint, the index.ts wiring) accepts `SlackTransport`
// instead of importing the concrete classes. This file is the one place that
// references both, keeping the transport choice opaque to everything else.

import type { SlackHttpChannel } from "./slack-http-receiver.ts";
import type { SlackChannel } from "./slack.ts";

export type SlackTransport = SlackChannel | SlackHttpChannel;
