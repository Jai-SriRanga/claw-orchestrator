/**
 * Purpose-built helper: run the standard verification pipeline in a worktree,
 * spawn a Claude session to fix mechanical errors on red, retry up to N rounds.
 *
 * Not to be confused with src/autoloop/, which is a planner/coder/reviewer
 * message-bus orchestrator for a different problem shape.
 */

import { spawn } from 'node:child_process';

export interface ShellResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ShellResult>;

export interface FixerArgs {
  worktreePath: string;
  failingCommand: string;
  tail: string;
}

export type FixerSpawner = (args: FixerArgs) => Promise<void>;

export interface FixOnFailureArgs {
  worktreePath: string;
  maxRounds: number;
  shell?: ShellRunner;
  spawnFixer?: FixerSpawner;
  steps?: Array<{ cmd: string; args: string[]; required?: boolean }>;
}

export interface FixOnFailureResult {
  ok: boolean;
  rounds: number;
  lastError?: string;
  failingCommand?: string;
}

const DEFAULT_STEPS: NonNullable<FixOnFailureArgs['steps']> = [
  { cmd: 'npm', args: ['install'] },
  { cmd: 'npm', args: ['run', 'build'] },
  { cmd: 'npm', args: ['test'] },
  { cmd: 'docker', args: ['build', '-t', 'ultraapp-fix:test', '.'] },
];

const TAIL_LINES = 200;

export async function runFixOnFailure(args: FixOnFailureArgs): Promise<FixOnFailureResult> {
  const shell = args.shell ?? realShell;
  const spawnFixer = args.spawnFixer ?? defaultSpawnFixer;
  const steps = args.steps ?? DEFAULT_STEPS;

  let rounds = 0;
  while (true) {
    const failure = await runPipelineOnce(shell, args.worktreePath, steps);
    if (failure === null) return { ok: true, rounds };

    if (rounds >= args.maxRounds) {
      return {
        ok: false,
        rounds,
        lastError: failure.lastError,
        failingCommand: failure.failingCommand,
      };
    }
    rounds++;
    await spawnFixer({
      worktreePath: args.worktreePath,
      failingCommand: failure.failingCommand,
      tail: failure.tail,
    });
  }
}

async function runPipelineOnce(
  shell: ShellRunner,
  cwd: string,
  steps: NonNullable<FixOnFailureArgs['steps']>,
): Promise<{ failingCommand: string; lastError: string; tail: string } | null> {
  for (const step of steps) {
    const r = await shell(step.cmd, step.args, { cwd });
    if (!r.ok) {
      const cmdline = `${step.cmd} ${step.args.join(' ')}`;
      const tail = lastN(r.stderr || r.stdout, TAIL_LINES);
      return { failingCommand: cmdline, lastError: tail.slice(0, 500), tail };
    }
  }
  return null;
}

function lastN(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.slice(-n).join('\n');
}

// Only the tail of build output is ever used (see lastN). Cap each stream so a
// runaway build (e.g. a watch loop printing forever) can't OOM the process.
const MAX_CAPTURE_BYTES = 512 * 1024;
function appendCapped(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
}

const realShell: ShellRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout = appendCapped(stdout, d.toString())));
    child.stderr.on('data', (d: Buffer) => (stderr = appendCapped(stderr, d.toString())));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on('error', (e) => resolve({ ok: false, stdout, stderr: stderr + e.message }));
  });

const defaultSpawnFixer: FixerSpawner = async (args) => {
  const { spawnFixerSession } = await import('./fix-on-failure-session.js');
  await spawnFixerSession(args);
};
