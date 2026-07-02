/**
 * Unit tests for SessionManager.autoloopStart()'s engine plumbing.
 *
 * Strategy: mock ClaudeAgentDispatcher (autoloop/dispatcher.js) so no real
 * persistent sessions or ledger I/O happen; we only assert that the
 * ClaudeAgentDispatcherConfig SessionManager builds from autoloopStart's
 * opts carries plannerEngine/coderEngine/reviewerEngine through correctly.
 * This is the layer between the `autoloop_start` tool (src/index.ts) and
 * the dispatcher itself (src/autoloop/dispatcher.ts, covered directly in
 * autoloop-dispatcher.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock node:fs ────────────────────────────────────────────────────────────
//
// SessionManager persists its own session index (claude-sessions.json) and
// autoloopStart appends to ~/.claw-orchestrator/autoloop-registry.jsonl on
// every successful start. Both must be no-ops in tests so we never touch the
// developer's real home directory.

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const isSandboxed = (p: unknown) =>
    typeof p === 'string' && (p.includes('claude-sessions.json') || p.includes('.claw-orchestrator'));
  const overrides = {
    existsSync: vi.fn((p: string) => (isSandboxed(p) ? false : actual.existsSync(p))),
    readFileSync: vi.fn((p: string, enc?: string) =>
      isSandboxed(p) ? '[]' : actual.readFileSync(p, enc as BufferEncoding),
    ),
    writeFileSync: vi.fn((p: string, ...rest: unknown[]) =>
      isSandboxed(p) ? undefined : (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest),
    ),
    appendFileSync: vi.fn((p: string, ...rest: unknown[]) =>
      isSandboxed(p) ? undefined : (actual.appendFileSync as (...a: unknown[]) => void)(p, ...rest),
    ),
    mkdirSync: vi.fn((p: string, ...rest: unknown[]) =>
      isSandboxed(p) ? undefined : (actual.mkdirSync as (...a: unknown[]) => void)(p, ...rest),
    ),
    renameSync: vi.fn((..._args: unknown[]) => {}),
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

// ─── Mock ClaudeAgentDispatcher ─────────────────────────────────────────────

interface CapturedConfig {
  runId: string;
  plannerModel?: string;
  plannerEngine?: string;
  coderEngine?: string;
  reviewerEngine?: string;
}

const capturedConfigs: CapturedConfig[] = [];

vi.mock('../autoloop/dispatcher.js', () => {
  class FakeDispatcher {
    config: CapturedConfig;
    constructor(config: CapturedConfig) {
      this.config = config;
      capturedConfigs.push(config);
    }
    get sessionNames() {
      return { planner: `autoloop-${this.config.runId}-planner`, coder: 'c', reviewer: 'r' };
    }
    async init(): Promise<void> {}
    async shutdown(): Promise<void> {}
    async deliver(): Promise<unknown[]> {
      return [];
    }
    async spawnSubagents(): Promise<void> {}
    on(): this {
      return this;
    }
    off(): this {
      return this;
    }
    emit(): boolean {
      return true;
    }
  }
  return { ClaudeAgentDispatcher: FakeDispatcher };
});

const { SessionManager } = await import('../session-manager.js');

let mgr: InstanceType<typeof SessionManager>;
let runId: string;

beforeEach(() => {
  capturedConfigs.length = 0;
  mgr = new SessionManager({ claudeBin: 'mock-claude' });
  runId = `test-run-${Math.random().toString(36).slice(2)}`;
});

afterEach(async () => {
  await mgr.autoloopStop(runId).catch(() => {});
});

describe('SessionManager.autoloopStart — engine plumbing', () => {
  it('defaults to no engine overrides (dispatcher applies its own claude default)', async () => {
    await mgr.autoloopStart({ runId, workspace: '/tmp/autoloop-plumbing-test' });
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0].plannerEngine).toBeUndefined();
    expect(capturedConfigs[0].coderEngine).toBeUndefined();
    expect(capturedConfigs[0].reviewerEngine).toBeUndefined();
  });

  it('passes plannerEngine/coderEngine/reviewerEngine through to the dispatcher config', async () => {
    await mgr.autoloopStart({
      runId,
      workspace: '/tmp/autoloop-plumbing-test',
      plannerModel: 'opus',
      plannerEngine: 'codex',
      coderEngine: 'claude',
      reviewerEngine: 'codex',
    });
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]).toMatchObject({
      runId,
      plannerModel: 'opus',
      plannerEngine: 'codex',
      coderEngine: 'claude',
      reviewerEngine: 'codex',
    });
  });
});
