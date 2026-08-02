/**
 * RealtimeClient socket lifecycle.
 *
 * Regression coverage for the reconnect path: a superseded socket must not be
 * able to re-enter the reconnect loop or write to the current connection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RealtimeClient,
  type RealtimeCredentials,
  type RealtimeHandlers,
} from '../client/src/realtime.js';

const CREDENTIALS: RealtimeCredentials = {
  token: 'ephemeral-token',
  expiresAt: 9_999_999,
  realtimeUrl: 'wss://api.x.ai/v1/realtime',
  model: 'grok-voice-latest',
  sampleRate: 24_000,
  turnMode: 'push_to_talk',
  session: { voice: 'eve' },
  conversationId: null,
};

/** Minimal stand-in for the browser WebSocket, driven manually by the tests. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Simulate the server completing the handshake. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Simulate the connection dropping. */
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('connect', () => {
  it('passes the ephemeral token as a subprotocol, not a header', () => {
    new RealtimeClient({}).connect(CREDENTIALS);

    const socket = FakeWebSocket.instances[0]!;
    expect(socket.protocols).toEqual(['xai-client-secret.ephemeral-token']);
  });

  it('puts the model on the query string', () => {
    new RealtimeClient({}).connect(CREDENTIALS);
    expect(FakeWebSocket.instances[0]!.url).toContain('model=grok-voice-latest');
  });

  it('requests conversation resumption when an id is known', () => {
    new RealtimeClient({}).connect({ ...CREDENTIALS, conversationId: 'conv_42' });
    expect(FakeWebSocket.instances[0]!.url).toContain('conversation_id=conv_42');
  });

  it('sends the server-built session on open', () => {
    new RealtimeClient({}).connect(CREDENTIALS);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'session.update',
      session: { voice: 'eve' },
    });
  });
});

describe('superseded sockets', () => {
  it('closes the previous socket when connect is called again', () => {
    const client = new RealtimeClient({});
    client.connect(CREDENTIALS);
    const first = FakeWebSocket.instances[0]!;

    client.connect(CREDENTIALS);

    expect(first.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('does not re-enter the reconnect loop when a superseded socket closes', () => {
    const onClose = vi.fn();
    const client = new RealtimeClient({ onClose });

    // First attempt is still CONNECTING — this is the reachable case, since
    // `connected` is false for a socket that has not finished opening.
    client.connect(CREDENTIALS);
    const stale = FakeWebSocket.instances[0]!;

    client.connect(CREDENTIALS);
    stale.drop();

    // Before the fix this fired with intentional=false and stacked a second
    // reconnect on top of the live socket.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores a late handshake from a superseded socket', () => {
    const onOpen = vi.fn();
    const client = new RealtimeClient({ onOpen });

    client.connect(CREDENTIALS);
    const stale = FakeWebSocket.instances[0]!;

    client.connect(CREDENTIALS);
    const live = FakeWebSocket.instances[1]!;

    stale.open();

    // A stale open must not push a duplicate session.update down the current
    // connection, nor report the client as newly connected.
    expect(onOpen).not.toHaveBeenCalled();
    expect(live.sent).toHaveLength(0);
  });

  it('ignores messages from a superseded socket', () => {
    const onAudioDelta = vi.fn();
    const client = new RealtimeClient({ onAudioDelta });

    client.connect(CREDENTIALS);
    const stale = FakeWebSocket.instances[0]!;
    client.connect(CREDENTIALS);

    stale.onmessage?.({
      data: JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }),
    } as MessageEvent);

    expect(onAudioDelta).not.toHaveBeenCalled();
  });

  it('reports the live socket as connected after a reconnect', () => {
    const client = new RealtimeClient({});
    client.connect(CREDENTIALS);
    client.connect(CREDENTIALS);

    FakeWebSocket.instances[1]!.open();
    expect(client.connected).toBe(true);
  });
});

describe('close', () => {
  it('marks the close as intentional so no reconnect is scheduled', () => {
    const onClose = vi.fn();
    const client = new RealtimeClient({ onClose });

    client.connect(CREDENTIALS);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    client.close();

    expect(socket.closeCalls).toBe(1);
    // Handlers are detached on close, so a trailing close event is inert.
    socket.drop();
    expect(onClose).not.toHaveBeenCalled();
    expect(client.connected).toBe(false);
  });

  it('is safe to call twice', () => {
    const client = new RealtimeClient({});
    client.connect(CREDENTIALS);
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});

describe('event dispatch', () => {
  /** Build a client with a socket already open and its handshake traffic cleared. */
  function connected(handlers: RealtimeHandlers = {}) {
    const client = new RealtimeClient(handlers);
    client.connect(CREDENTIALS);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.sent.length = 0;
    return { client, socket };
  }

  it('surfaces a real drop to the reconnect path', () => {
    const onClose = vi.fn();
    const { socket } = connected({ onClose });

    socket.drop();
    expect(onClose).toHaveBeenCalledWith({ intentional: false });
  });

  it('routes a tool call with its call id and arguments', () => {
    const onToolCall = vi.fn();
    const { socket } = connected({ onToolCall });

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'response.function_call_arguments.done',
        call_id: 'call_1',
        name: 'ask_hermes',
        arguments: '{"request":"what is on my calendar"}',
      }),
    } as MessageEvent);

    expect(onToolCall).toHaveBeenCalledWith({
      callId: 'call_1',
      name: 'ask_hermes',
      args: '{"request":"what is on my calendar"}',
    });
  });

  it('accepts either documented spelling of the audio delta event', () => {
    const onAudioDelta = vi.fn();
    const { socket } = connected({ onAudioDelta });

    for (const type of ['response.output_audio.delta', 'response.audio.delta']) {
      socket.onmessage?.({ data: JSON.stringify({ type, delta: 'AAAA' }) } as MessageEvent);
    }

    expect(onAudioDelta).toHaveBeenCalledTimes(2);
  });

  it('survives malformed JSON without tearing down the session', () => {
    const onError = vi.fn();
    const { socket, client } = connected({ onError });

    expect(() => socket.onmessage?.({ data: 'not json' } as MessageEvent)).not.toThrow();
    expect(client.connected).toBe(true);
  });

  it('drops sends when the socket is not open', () => {
    const client = new RealtimeClient({});
    client.connect(CREDENTIALS);
    const socket = FakeWebSocket.instances[0]!;

    // Still CONNECTING — queuing here would throw in a real browser.
    client.appendAudio('AAAA');
    expect(socket.sent).toHaveLength(0);
  });

  it('commits a push-to-talk turn and asks for a response', () => {
    const { client, socket } = connected();

    client.commitTurn();

    expect(socket.sent.map((raw) => JSON.parse(raw).type)).toEqual([
      'input_audio_buffer.commit',
      'response.create',
    ]);
  });

  it('returns a tool result and resumes the response', () => {
    const { client, socket } = connected();

    client.sendToolResult('call_1', 'Hermes says hello.');

    const [item, resume] = socket.sent.map((raw) => JSON.parse(raw));
    expect(item).toEqual({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Hermes says hello.',
      },
    });
    expect(resume.type).toBe('response.create');
  });
});
