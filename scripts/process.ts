import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CommandOutcome { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; }
export async function commandOutcome(binary: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end();
    let stdout = '', stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeoutMs ?? 60000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}
export async function command(binary: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<string> {
  const result = await commandOutcome(binary, args, options);
  if (result.code !== 0 || result.timedOut) throw new Error(`${binary}: code=${result.code} signal=${result.signal ?? 'none'} timeout=${result.timedOut}\n${result.stderr.slice(-6000)}\n${result.stdout.slice(-6000)}`);
  return result.stdout;
}
export function isolatedEnvironment(home: string, additions: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: home, LANG: 'en_US.UTF-8', TERM: 'dumb',
    PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    ...additions,
  };
}
export async function recordEvidence(root: string, name: string, value: unknown): Promise<string> {
  const dir = join(root, '.artifacts'); await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}
