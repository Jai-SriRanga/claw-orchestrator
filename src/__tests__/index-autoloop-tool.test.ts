/**
 * Unit test for the `autoloop_start` tool's argument mapping in src/index.ts.
 *
 * Strategy: mock SessionManager so no real sessions/HTTP server are created;
 * we only assert that the tool's `execute()` correctly maps the JSON-schema
 * snake_case args (planner_engine / coder_engine / reviewer_engine) onto the
 * camelCase SessionManager.autoloopStart() opts. Complements
 * session-manager-autoloop.test.ts (SessionManager → dispatcher plumbing)
 * and autoloop-dispatcher.test.ts (dispatcher → engine selection).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.CLAWO_NO_EMBEDDED_SERVER = '1';

interface CapturedAutoloopStartOpts {
  runId: string;
  workspace: string;
  plannerModel?: string;
  plannerEngine?: string;
  coderEngine?: string;
  reviewerEngine?: string;
  sendTimeoutMs?: number;
}

const autoloopStartMock = vi.fn(async (opts: CapturedAutoloopStartOpts) => ({
  runId: opts.runId,
  plannerSession: `autoloop-${opts.runId}-planner`,
  state: {},
}));

vi.mock('../session-manager.js', () => {
  class FakeSessionManager {
    autoloopStart = autoloopStartMock;
  }
  return { SessionManager: FakeSessionManager };
});

const plugin = (await import('../index.js')).default;

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
}

function collectTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const fakeApi = {
    pluginConfig: {},
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    registerTool: (def: RegisteredTool) => tools.set(def.name, def),
    on: () => {},
    registerHttpRoute: () => {},
    registerService: () => {},
  };
  (plugin as unknown as { register: (api: unknown) => void }).register(fakeApi);
  return tools;
}

describe('autoloop_start tool — engine arg mapping', () => {
  beforeEach(() => {
    autoloopStartMock.mockClear();
  });

  it('maps planner_engine/coder_engine/reviewer_engine to camelCase opts', async () => {
    const tools = collectTools();
    const tool = tools.get('autoloop_start');
    expect(tool).toBeDefined();

    await tool!.execute('call-1', {
      run_id: 'r1',
      workspace: '/tmp/autoloop-tool-test',
      planner_model: 'opus',
      planner_engine: 'codex',
      coder_engine: 'claude',
      reviewer_engine: 'codex',
      send_timeout_ms: 5000,
    });

    expect(autoloopStartMock).toHaveBeenCalledTimes(1);
    const opts = autoloopStartMock.mock.calls[0][0];
    expect(opts).toMatchObject({
      runId: 'r1',
      plannerModel: 'opus',
      plannerEngine: 'codex',
      coderEngine: 'claude',
      reviewerEngine: 'codex',
      sendTimeoutMs: 5000,
    });
  });

  it('leaves engine opts undefined when the caller omits them', async () => {
    const tools = collectTools();
    const tool = tools.get('autoloop_start');

    await tool!.execute('call-2', {
      run_id: 'r2',
      workspace: '/tmp/autoloop-tool-test',
    });

    const opts = autoloopStartMock.mock.calls[0][0];
    expect(opts.plannerEngine).toBeUndefined();
    expect(opts.coderEngine).toBeUndefined();
    expect(opts.reviewerEngine).toBeUndefined();
  });
});
