import type { StatusV2 } from "./status-schema.ts";

/** Opt-in preview for loopback renderers. Bounded to three pending messages; no bodies or authority. */
export interface StatusInboxMessage {
  id: string;
  sender: string;
  subject: string;
  kind: string;
  ts: string;
  needs_reply: boolean;
}

/** Additive extension: the pinned base v2 contract stays unchanged for existing clients. */
export type StatusV2WithInbox = Omit<StatusV2, "inbox"> & {
  inbox: StatusV2["inbox"] & { recent?: StatusInboxMessage[] };
};
