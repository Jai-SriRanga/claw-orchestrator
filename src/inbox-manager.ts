/**
 * Cross-session messaging (inbox) manager.
 *
 * Manages message delivery between sessions. Idle sessions receive messages
 * immediately; busy sessions queue for later delivery via deliverInbox().
 */

import type { InboxMessage, ISession } from './types.js';
import { MAX_INBOX_SIZE } from './constants.js';

/**
 * Callback interface — allows InboxManager to look up sessions
 * without depending on SessionManager directly.
 */
export interface SessionLookup {
  getSession(name: string): { session: ISession } | undefined;
  exists(name: string): boolean;
  allNames(): Iterable<string>;
}

export class InboxManager {
  private inboxes = new Map<string, InboxMessage[]>();

  static escapeXmlAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  wrapCrossSessionMessage(msg: InboxMessage): string {
    const esc = InboxManager.escapeXmlAttr;
    const attrs = `from="${esc(msg.from)}"${msg.summary ? ` summary="${esc(msg.summary)}"` : ''}`;
    return `<cross-session-message ${attrs}>\n${msg.text}\n</cross-session-message>`;
  }

  /**
   * Send a message from one session to another (or broadcast with to='*').
   * Returns whether the message was delivered immediately or queued.
   */
  async sendTo(
    from: string,
    to: string,
    message: string,
    lookup: SessionLookup,
    summary?: string,
    onBroadcastError?: (name: string, err: Error) => void,
  ): Promise<{ delivered: boolean; queued: boolean }> {
    if (!lookup.exists(from)) throw new Error(`Sender session '${from}' not found`);
    if (to !== '*' && !lookup.exists(to)) throw new Error(`Target session '${to}' not found`);

    const inboxMsg: InboxMessage = {
      from,
      text: message,
      timestamp: new Date().toISOString(),
      read: false,
      summary,
    };

    // Broadcast
    if (to === '*') {
      let delivered = 0;
      for (const name of lookup.allNames()) {
        if (name === from) continue;
        try {
          const ok = await this._deliverOrQueue(name, inboxMsg, lookup);
          if (ok) delivered++;
        } catch (err) {
          onBroadcastError?.(name, err as Error);
        }
      }
      return { delivered: delivered > 0, queued: delivered === 0 };
    }

    const delivered = await this._deliverOrQueue(to, inboxMsg, lookup);
    return { delivered, queued: !delivered };
  }

  /** Read inbox messages for a session. */
  inbox(name: string, unreadOnly = true): InboxMessage[] {
    const box = this.inboxes.get(name) || [];
    return unreadOnly ? box.filter((m) => !m.read) : box;
  }

  /** Deliver all queued unread messages to a session, mark as read. */
  async deliverInbox(name: string, lookup: SessionLookup): Promise<number> {
    const managed = lookup.getSession(name);
    if (!managed) throw new Error(`Session '${name}' not found`);
    const box = this.inboxes.get(name);
    if (!box || box.length === 0) return 0;

    const unread = box.filter((m) => !m.read);
    if (unread.length === 0) return 0;

    const formatted = unread.map((m) => this.wrapCrossSessionMessage(m)).join('\n\n');
    await managed.session.send(formatted, { waitForComplete: false });
    for (const m of unread) m.read = true;
    return unread.length;
  }

  /** Clear inbox for a session. */
  clear(name: string): void {
    this.inboxes.delete(name);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async _deliverOrQueue(sessionName: string, sharedMsg: InboxMessage, lookup: SessionLookup): Promise<boolean> {
    const managed = lookup.getSession(sessionName);
    if (!managed) return false;

    // Per-recipient copy: a broadcast passes the SAME message object to every
    // recipient, so mutating read-state in place would let an idle recipient's
    // delivery mark a busy recipient's queued copy as already-read (then
    // deliverInbox filters it out and it's lost).
    const msg: InboxMessage = { ...sharedMsg };

    // If session is idle, deliver directly
    if (!managed.session.isBusy && managed.session.isReady) {
      try {
        await managed.session.send(this.wrapCrossSessionMessage(msg), { waitForComplete: false });
        msg.read = true;
        return true;
      } catch {
        // Fall through to queue
      }
    }

    // Queue in inbox (with size cap — drop oldest read messages first)
    if (!this.inboxes.has(sessionName)) this.inboxes.set(sessionName, []);
    const box = this.inboxes.get(sessionName)!;
    if (box.length >= MAX_INBOX_SIZE) {
      const readIdx = box.findIndex((m) => m.read);
      if (readIdx >= 0) box.splice(readIdx, 1);
      else box.shift(); // drop oldest unread as last resort
    }
    box.push(msg);
    return false;
  }
}
