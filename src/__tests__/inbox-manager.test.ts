/**
 * Unit tests for InboxManager cross-session delivery.
 *
 * No real sessions — a minimal fake ISession (idle/busy/ready + recorded sends)
 * and a SessionLookup over a Map drive the delivery/queue/broadcast paths.
 */

import { describe, it, expect, vi } from 'vitest';
import { InboxManager, type SessionLookup } from '../inbox-manager.js';
import type { ISession } from '../types.js';

function fakeSession(opts: { busy?: boolean; ready?: boolean; throwOnSend?: boolean } = {}) {
  const sends: string[] = [];
  const session = {
    isBusy: opts.busy ?? false,
    isReady: opts.ready ?? true,
    send: vi.fn(async (text: string) => {
      if (opts.throwOnSend) throw new Error('send failed');
      sends.push(text);
      return { requestId: 1, sent: true };
    }),
  } as unknown as ISession;
  return { session, sends };
}

function makeLookup(map: Map<string, { session: ISession }>): SessionLookup {
  return {
    getSession: (name) => map.get(name),
    exists: (name) => map.has(name),
    allNames: () => map.keys(),
  };
}

describe('InboxManager', () => {
  it('delivers immediately to an idle, ready session', async () => {
    const a = fakeSession();
    const b = fakeSession({ busy: false, ready: true });
    const map = new Map([
      ['a', { session: a.session }],
      ['b', { session: b.session }],
    ]);
    const im = new InboxManager();

    const r = await im.sendTo('a', 'b', 'hello', makeLookup(map));
    expect(r).toEqual({ delivered: true, queued: false });
    expect(b.sends.length).toBe(1);
    expect(b.sends[0]).toContain('hello');
    // Nothing left queued.
    expect(im.inbox('b').length).toBe(0);
  });

  it('queues for a busy session, then deliverInbox flushes it', async () => {
    const a = fakeSession();
    const b = fakeSession({ busy: true });
    const map = new Map([
      ['a', { session: a.session }],
      ['b', { session: b.session }],
    ]);
    const im = new InboxManager();

    const r = await im.sendTo('a', 'b', 'queued msg', makeLookup(map));
    expect(r).toEqual({ delivered: false, queued: true });
    expect(im.inbox('b').length).toBe(1);

    // Now b is free.
    (b.session as { isBusy: boolean }).isBusy = false;
    const n = await im.deliverInbox('b', makeLookup(map));
    expect(n).toBe(1);
    expect(b.sends[0]).toContain('queued msg');
    // Marked read after delivery.
    expect(im.inbox('b').length).toBe(0);
  });

  it('broadcast delivers to idle AND still delivers to busy recipients later (no shared-read-state loss)', async () => {
    const sender = fakeSession();
    const idle = fakeSession({ busy: false });
    const busy = fakeSession({ busy: true });
    const map = new Map([
      ['sender', { session: sender.session }],
      ['idle', { session: idle.session }],
      ['busy', { session: busy.session }],
    ]);
    const im = new InboxManager();

    await im.sendTo('sender', '*', 'broadcast', makeLookup(map));
    // Idle got it immediately.
    expect(idle.sends.length).toBe(1);
    // Busy one was queued — and must NOT have been marked read by the idle delivery.
    expect(im.inbox('busy').length).toBe(1);
    expect(im.inbox('busy')[0].read).toBe(false);

    (busy.session as { isBusy: boolean }).isBusy = false;
    const n = await im.deliverInbox('busy', makeLookup(map));
    expect(n).toBe(1);
    expect(busy.sends[0]).toContain('broadcast');
  });

  it('throws on unknown sender or target', async () => {
    const a = fakeSession();
    const map = new Map([['a', { session: a.session }]]);
    const im = new InboxManager();
    await expect(im.sendTo('ghost', 'a', 'x', makeLookup(map))).rejects.toThrow(/Sender/);
    await expect(im.sendTo('a', 'ghost', 'x', makeLookup(map))).rejects.toThrow(/Target/);
  });

  it('falls back to queue when an idle session send throws', async () => {
    const a = fakeSession();
    const b = fakeSession({ busy: false, throwOnSend: true });
    const map = new Map([
      ['a', { session: a.session }],
      ['b', { session: b.session }],
    ]);
    const im = new InboxManager();
    const r = await im.sendTo('a', 'b', 'will-queue', makeLookup(map));
    expect(r.queued).toBe(true);
    expect(im.inbox('b').length).toBe(1);
  });

  it('escapes XML metacharacters in the wrapper', () => {
    const im = new InboxManager();
    const wrapped = im.wrapCrossSessionMessage({
      from: 'a&b"<c>',
      text: 'body',
      timestamp: 't',
      read: false,
    });
    expect(wrapped).toContain('from="a&amp;b&quot;&lt;c&gt;"');
    expect(wrapped).toContain('body');
  });
});
