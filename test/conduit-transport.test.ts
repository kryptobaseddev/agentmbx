// Council Transport experiment. No production adapter or cross-host conformance claim.
// Copied contract signatures (no cross-repo imports), CLEO revision:
// 6a9d753b42938a8861ea8cc825079ea7101698ca, packages/contracts/src/{transport,conduit,agent-registry}.ts.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MbxNode, type Session } from "../src/node.ts";
import { generateKeyPair } from "../src/crypto.ts";
import { verifyEnvelope } from "../src/envelope.ts";

export interface TransportConfig {
  /** Polling interval in milliseconds (for HTTP polling transport). */
  pollIntervalMs?: number;
  /** SSE endpoint URL (for Server-Sent Events transport). */
  sseEndpoint?: string;
  /** WebSocket URL (for WebSocket transport). */
  wsUrl?: string;
  /** HTTP polling endpoint path (for HTTP polling transport). */
  pollEndpoint?: string;
}

export interface TransportConnectConfig extends TransportConfig {
  /** Agent ID to connect as. */
  agentId: string;
  /** API key for authentication. */
  apiKey: string;
  /** Base URL of the messaging API. */
  apiBaseUrl: string;
}

export interface ConduitMessage {
  /** Unique message ID. */
  id: string;
  /** Sender agent ID. */
  from: string;
  /** Message content (text). */
  content: string;
  /** Optional tags for message classification (e.g. #status, #decision). */
  tags?: string[];
  /** Thread ID for conversation threading. */
  threadId?: string;
  /** Group ID if sent to a group conversation. */
  groupId?: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Optional structured metadata. */
  metadata?: Record<string, unknown>;
  /**
   * Message semantics for A2A (Agent-to-Agent) coordination.
   *
   * - `message` — default, backward-compat direct message
   * - `request` — sender expects a response; receiver should reply
   * - `notify`  — informational broadcast; no response expected
   * - `subscribe` — sender subscribes to a topic
   *
   * @default `"message"` for backward compatibility
   * @see T1252 CONDUIT A2A
   */
  kind?: 'message' | 'request' | 'notify' | 'subscribe';
  /**
   * Sender peer identity — stable peer ID from PeerIdentity.peerId.
   * Populated for A2A topic messages; absent on legacy direct messages.
   *
   * @see T1252 CONDUIT A2A
   */
  fromPeerId?: string;
  /**
   * Recipient peer identity — agent peerId for direct messages, `null` for
   * topic broadcasts (one-to-many).
   *
   * @see T1252 CONDUIT A2A
   */
  toPeerId?: string | null;
  /**
   * Structured payload accompanying the message.
   *
   * JSON-serializable object; stored as TEXT in the database.
   * Used for structured A2A coordination data (findings, events, etc.).
   *
   * @see T1252 CONDUIT A2A
   */
  payload?: Record<string, unknown>;
}

export interface ConduitTopicSubscribeOptions {
  /**
   * Filter messages by kind. When absent, all kinds are delivered.
   * @example `['notify', 'request']`
   */
  filter?: {
    /** Accept only these message kinds. */
    kind?: Array<'message' | 'request' | 'notify' | 'subscribe'>;
    /** Accept only messages whose `payload.event` is in this list. */
    event?: string[];
  };
}

export interface ConduitTopicPublishOptions {
  /**
   * Message kind.
   * @default `"message"`
   */
  kind?: 'message' | 'request' | 'notify' | 'subscribe';
  /** Structured payload to attach to the message. */
  payload?: Record<string, unknown>;
}

export type ConduitUnsubscribe = () => void;

export interface Transport {
  /** Transport name for logging/debugging (e.g. 'http', 'sse', 'ws', 'local'). */
  readonly name: string;

  /** Connect to the messaging backend. */
  connect(config: TransportConnectConfig): Promise<void>;

  /** Disconnect from the messaging backend. */
  disconnect(): Promise<void>;

  /** Send a message payload. */
  push(
    to: string,
    content: string,
    options?: {
      conversationId?: string;
      replyTo?: string;
    },
  ): Promise<{ messageId: string }>;

  /** Poll for new messages (non-destructive peek). */
  poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]>;

  /** Acknowledge processed messages (marks as delivered). */
  ack(messageIds: string[]): Promise<void>;

  /** Subscribe to real-time events (SSE/WebSocket). Returns unsubscribe. */
  subscribe?(handler: (message: ConduitMessage) => void): () => void;

  // ── A2A Topic Operations (T1252 — optional, LocalTransport only) ─────────

  /**
   * Subscribe agent to a named topic.
   *
   * Optional — only implemented by `LocalTransport`. Cloud transports
   * (HttpTransport, SseTransport) do not yet support topic operations.
   *
   * @param topicName - Topic name, e.g. `"epic-T1149.wave-2"`.
   * @param options   - Subscription filter options.
   * @task T1252
   */
  subscribeTopic?(topicName: string, options?: ConduitTopicSubscribeOptions): Promise<void>;

  /**
   * Publish a message to a named topic.
   *
   * Optional — only implemented by `LocalTransport`.
   *
   * @param topicName - Target topic name.
   * @param content   - Message content.
   * @param options   - Kind and optional payload.
   * @task T1252
   */
  publishToTopic?(
    topicName: string,
    content: string,
    options?: ConduitTopicPublishOptions,
  ): Promise<{ messageId: string }>;

  /**
   * Register a real-time handler for topic messages.
   *
   * Optional — only implemented by `LocalTransport`.
   *
   * @param topicName - Topic name to watch.
   * @param handler   - Handler invoked for each new message.
   * @returns Unsubscribe function.
   * @task T1252
   */
  onTopic?(topicName: string, handler: (message: ConduitMessage) => void): ConduitUnsubscribe;

  /**
   * Unsubscribe agent from a named topic.
   *
   * Optional — only implemented by `LocalTransport`.
   *
   * @param topicName - Topic name to leave.
   * @task T1252
   */
  unsubscribeTopic?(topicName: string): Promise<void>;
}

// INVENTED: adapter decisions, not guarantees supplied by MbxNode or CLEO.
export const INVENTED = [
  'name = "mbx-local-experiment"; local in-process connection only.',
  'connect agentId is a local mailbox label, not an authenticated principal; register it without a session lease.',
  'apiKey must be empty, apiBaseUrl must be "mbx://h1"; reject other values rather than pretend to authenticate/use HTTP.',
  'TransportConfig endpoint/polling fields are unsupported and rejected; connect stores state, disconnect clears it (shared node remains open).',
  'push subject = "Conduit message"; kind is MbxNode default message; needs_reply=false, refs=[] and no owner grant.',
  'conversationId maps to thread; replyTo maps to reply_to. replyTo alone does not infer conversationId.',
  'poll defaults limit to 50; since is an exclusive ISO timestamp cutoff on sender ts, applied before limit (not an arrival cursor).',
  'poll scans all unacked rows using MbxNode inbox limit=-1; this is an unbounded experimental scan, not a scalable production cursor.',
  'ack agent comes from connect.agentId; MBX acked is treated as conduit processed/delivered, despite different state terminology.',
  'poll metadata.mbx carries observed trust, parsed authority and reply_to; no invented authenticated fromPeerId.',
  'Only required message fields plus threadId and mbx metadata are mapped; optional topics, subscription, payload/group/peer IDs and kind/tag projection are not implemented.',
] as const;

class MbxTransport implements Transport {
  readonly name = "mbx-local-experiment";
  private agent: string | null = null;
  private node: MbxNode;
  private session?: Session;
  constructor(node: MbxNode, session?: Session) { this.node = node; this.session = session; }
  async connect(config: TransportConnectConfig): Promise<void> {
    if (config.apiKey !== "" || config.apiBaseUrl !== `mbx://${this.node.host}`)
      throw new Error("only local empty-key config is supported");
    if ([config.pollIntervalMs, config.sseEndpoint, config.wsUrl, config.pollEndpoint].some(x => x !== undefined))
      throw new Error("transport options unsupported");
    if (this.agent) throw new Error("already connected");
    this.node.registerAgent(config.agentId);
    this.agent = config.agentId;
  }
  async disconnect(): Promise<void> { this.agent = null; }
  private connected(): string { if (!this.agent) throw new Error("not connected"); return this.agent; }
  async push(to: string, content: string, options?: { conversationId?: string; replyTo?: string }): Promise<{ messageId: string }> {
    const result = this.node.send({ from: this.connected(), to: [to], subject: "Conduit message", body: content,
      thread: options?.conversationId, reply_to: options?.replyTo }, this.session);
    return { messageId: result.envelope.id };
  }
  async poll(options?: { limit?: number; since?: string }): Promise<ConduitMessage[]> {
    const agent = this.connected(), limit = options?.limit ?? 50;
    const since = options?.since === undefined ? -Infinity : Date.parse(options.since);
    if (!Number.isSafeInteger(limit) || limit < 0 || Number.isNaN(since)) throw new Error("invalid poll options");
    return this.node.inbox(agent, { limit: -1 }).filter(m => Date.parse(m.ts) > since).slice(0, limit).map(m => ({
      id: m.id, from: m.from_addr, content: m.body, threadId: m.thread, timestamp: m.ts,
      metadata: { mbx: { trust: m.trust, authority: m.authority ? JSON.parse(m.authority) : null, replyTo: m.reply_to } },
    }));
  }
  async ack(messageIds: string[]): Promise<void> {
    const agent = this.connected();
    for (const id of messageIds) this.node.ack(id, agent);
  }
}

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "mbx-conduit-"));
  const node = new MbxNode(home, { host: "h1", bind: "127.0.0.1", port: 0 });
  t.after(() => { node.store.close(); rmSync(home, { recursive: true, force: true }); });
  return node;
}
const config = (agentId: string): TransportConnectConfig => ({ agentId, apiKey: "", apiBaseUrl: "mbx://h1" });
const session = (): Session => { const k = generateKeyPair(); return { pub: k.publicKey, priv: k.privateKey, grant: null }; };

 test("connect/disconnect/name and unsupported authentication are explicit", async t => {
  const a = new MbxTransport(fixture(t));
  assert.equal(a.name, "mbx-local-experiment");
  await assert.rejects(a.poll(), /not connected/);
  await assert.rejects(a.connect({ ...config("lead"), apiKey: "not-an-mbx-credential" }), /only local/);
  await a.connect(config("lead"));
  assert.deepEqual(await a.poll(), []);
  await a.disconnect();
  await assert.rejects(a.push("worker@h1", "hi"), /not connected/);
  await assert.rejects(a.ack([]), /not connected/);
});

test("push returns the actual persisted message id", async t => {
  const node = fixture(t), lead = new MbxTransport(node);
  await lead.connect(config("lead"));
  node.registerAgent("worker");
  const { messageId } = await lead.push("worker@h1", "hello");
  assert.match(messageId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(node.read(messageId).body, "hello");
  assert.equal(node.read(messageId).from_addr, "lead@h1");
});

test("poll is a non-destructive peek with conversation and reply round-trip", async t => {
  const node = fixture(t), lead = new MbxTransport(node), worker = new MbxTransport(node);
  await lead.connect(config("lead")); await worker.connect(config("worker"));
  const first = await lead.push("worker@h1", "question", { conversationId: "wave-42" });
  const peek = await worker.poll();
  assert.equal(peek[0].id, first.messageId); assert.equal(peek[0].threadId, "wave-42");
  assert.deepEqual(await worker.poll(), peek);
  const reply = await worker.push("lead@h1", "answer", { conversationId: peek[0].threadId, replyTo: first.messageId });
  const back = await lead.poll();
  assert.equal(back[0].id, reply.messageId); assert.equal(back[0].threadId, "wave-42");
  assert.equal(node.read(reply.messageId).reply_to, first.messageId);
});

test("ack empties the next poll for the connected recipient only", async t => {
  const node = fixture(t), lead = new MbxTransport(node), worker = new MbxTransport(node);
  await lead.connect(config("lead")); await worker.connect(config("worker"));
  const msg = node.send({ from: "lead", to: ["worker@h1", "lead@h1"], subject: "both", body: "hello" });
  await worker.ack([msg.envelope.id]);
  assert.deepEqual(await worker.poll(), []);
  assert.equal((await lead.poll())[0].id, msg.envelope.id);
});

test("since cutoff is exclusive and applied before limit", async t => {
  const node = fixture(t), worker = new MbxTransport(node);
  await worker.connect(config("worker"));
  // Controlled input timestamps, signed through unmodified send; no database mutation.
  const { buildEnvelope } = await import("../src/envelope.ts");
  for (const second of [0, 1, 2]) {
    const draft = { from: "lead@h1", to: ["worker@h1"], subject: "dated", body: String(second) };
    node.send(draft, undefined, undefined, buildEnvelope(draft, new Date(`2026-09-26T00:00:0${second}Z`)));
  }
  const got = await worker.poll({ since: "2026-09-26T00:00:00Z", limit: 1 });
  assert.deepEqual(got.map(m => m.content), ["1"]);
  assert.equal((await worker.poll()).length, 3);
});

test("same-host spoofed lead: receiver cannot attribute ordinary messages to either session", async t => {
  const node = fixture(t), realSession = session(), fakeSession = session();
  assert.notEqual(realSession.pub, fakeSession.pub);
  const lead = new MbxTransport(node, realSession), impostor = new MbxTransport(node, fakeSession), worker = new MbxTransport(node);
  await lead.connect(config("lead")); await impostor.connect(config("lead")); await worker.connect(config("worker"));
  const real = await lead.push("worker@h1", "wave complete");
  const fake = await impostor.push("worker@h1", "wave complete");
  const messages = await worker.poll();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(m => m.from), ["lead@h1", "lead@h1"]);
  for (const id of [real.messageId, fake.messageId]) {
    const envelope = JSON.parse(node.read(id).envelope);
    assert.equal(verifyEnvelope(envelope, node.key.publicKey), true);
    assert.equal(envelope.authority, null);
    assert.equal(JSON.stringify(envelope).includes(realSession.pub), false);
    assert.equal(JSON.stringify(envelope).includes(fakeSession.pub), false);
  }
  assert.deepEqual(messages[0].metadata, messages[1].metadata);
  t.diagnostic("ATTRIBUTION FAIL: host signature verifies both labels; neither ordinary session identity is carried. No owner-authority forgery demonstrated.");
  await t.test("required before orchestration cutover: distinguish authenticated session principals", { todo: "ordinary session signatures/immutable IDs absent" }, () => {
    assert.ok(messages[0].fromPeerId && messages[1].fromPeerId && messages[0].fromPeerId !== messages[1].fromPeerId);
  });
});
