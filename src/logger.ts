import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function getLogDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
  return join(base, 'pi-cpa-proxy', 'logs');
}

let dirCreated = false;

function ensureLogDir(): string {
  const dir = getLogDir();
  if (!dirCreated) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      dirCreated = true;
    } catch {
      // non-fatal
    }
  }
  return dir;
}

export function logStreamEvent(level: 'INFO' | 'WARN' | 'ERROR', event: string, details?: Record<string, unknown> | string): void {
  try {
    const dir = ensureLogDir();
    const now = new Date().toISOString();
    const entry = typeof details === 'object' && details !== null
      ? `[${now}] [${level}] [${event}] ${JSON.stringify(details)}\n`
      : `[${now}] [${level}] [${event}] ${details ?? ''}\n`;
    appendFileSync(join(dir, 'stream.log'), entry, { mode: 0o600 });
  } catch {
    // Non-fatal: logging errors must never interrupt request lifecycle
  }
}
