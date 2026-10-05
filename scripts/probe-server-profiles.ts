import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { serverAdminSpec } from '../src/schema.ts';
import { openServerProfiles, profileStamp } from '../src/server-profiles.ts';
import { command, isolatedEnvironment, recordEvidence } from './process.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'cpa-native-profile-probe-'));
const supplied = process.argv[2];
const version = '8.0.13';
const digest = '652a192e3e38520253e330c4a094fa8916728370c3f213f127dbc56e35be7938';
let child: ChildProcess | undefined;
let exited: Promise<unknown> | undefined;
let logs = '';
try {
  let binary: string;
  if (supplied) binary = resolve(supplied);
  else {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('supply_binary_for_this_platform');
    const name = `CLIProxyAPI_${version}_darwin_aarch64.tar.gz`;
    const response = await fetch(`https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/${name}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('release_download_failed');
    const data = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(data).digest('hex'), digest);
    await writeFile(join(sandbox, name), data);
    const inventory = await command('tar', ['-tzf', name], { cwd: sandbox });
    assert.ok(inventory.trim().split('\n').every((name) => !name.startsWith('/') && !name.split('/').includes('..')));
    await command('tar', ['-xzf', name], { cwd: sandbox });
    binary = join(sandbox, 'cli-proxy-api');
    await chmod(binary, 0o700);
  }
  const home = join(sandbox, 'home'), auths = join(sandbox, 'auths');
  await mkdir(home); await mkdir(auths, { mode: 0o700 });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port; socket.close(); await once(socket, 'close');
  const endpoint = `http://127.0.0.1:${port}`;
  const admin = 'SYNTHETIC_PROFILE_ADMIN_KEY', client = 'SYNTHETIC_PROFILE_CLIENT_KEY';
  const env = isolatedEnvironment(home, { PROFILE_PROBE_ADMIN: admin, PROFILE_PROBE_CLIENT: client });
  await writeFile(join(auths, 'synthetic-codex.json'), JSON.stringify({
    type: 'codex', access_token: 'SYNTHETIC_NO_UPSTREAM_ACCESS', refresh_token: '', email: 'fixture@example.invalid',
    expired: '2099-01-01T00:00:00Z', last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  const path = join(sandbox, 'config.yaml');
  // Deliberately start in legacy layout to exercise real read projection and write migration.
  await writeFile(path, stringify({ host: '127.0.0.1', port, 'auth-dir': auths,
    'remote-management': { 'allow-remote': false, 'secret-key': admin, 'disable-control-panel': true },
    'api-keys': [client], routing: { strategy: 'fill-first', 'session-affinity': true },
    'oauth-model-alias': { codex: [], antigravity: [] }, 'oauth-settings': { codex: [], antigravity: [] },
    'request-retry': 0, 'logging-to-file': false,
  }), { mode: 0o600 });
  child = spawn(binary, ['-config', path], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  child.stdout?.on('data', (data) => { logs = (logs + data).slice(-30000); });
  child.stderr?.on('data', (data) => { logs = (logs + data).slice(-30000); });
  let source: string | undefined;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('native_gateway_exited');
    try {
      const response = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${client}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const body = await response.json() as { data: { id: string; owned_by: string }[] };
        source = body.data.find((model) => model.owned_by === 'openai')?.id ?? body.data[0]?.id;
        if (source) break;
      }
    } catch { /* Only synthetic local startup readiness retries. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!source) throw new Error('synthetic_oauth_catalogue_unavailable');
  const afterStartup = await readFile(path, 'utf8');
  const config = serverAdminSpec.parse({ kind: 'cli-proxy-api-v8', endpoint, allowInsecureHttp: true,
    credential: { kind: 'env', name: 'PROFILE_PROBE_ADMIN' }, allowProfileWrites: true,
    exclusiveConfigWriter: true, acceptLayoutMigration: true,
    aliases: { 'synthetic-server-role': { channel: 'codex', model: source, contextWindow: 1000000 } } });
  const oldAdmin = process.env.PROFILE_PROBE_ADMIN, oldClient = process.env.PROFILE_PROBE_CLIENT;
  process.env.PROFILE_PROBE_ADMIN = admin; process.env.PROFILE_PROBE_CLIENT = client;
  try {
    const adapter = openServerProfiles(config, { endpoint, credential: { kind: 'env', name: 'PROFILE_PROBE_CLIENT' }, timeoutMs: 8000 }, join(sandbox, 'state'));
    const plan = await adapter.preview(AbortSignal.timeout(20000));
    assert.equal(await readFile(path, 'utf8'), afterStartup, 'read-only preview mutated native config');
    const transaction = await adapter.apply(plan, profileStamp(plan), AbortSignal.timeout(30000));
    assert.equal((await adapter.inspect(AbortSignal.timeout(10000))).transaction, 'applied');
    const changed = parse(await readFile(path, 'utf8'));
    assert.deepEqual(changed.access['api-keys'], [client]);
    assert.equal(changed.routing.strategy, 'fill-first');
    assert.equal(changed.routing['session-affinity'], true);
    assert.equal(changed.oauth.settings.codex[0]['max-context-length'], 1000000);
    await adapter.rollback(transaction, AbortSignal.timeout(20000));
    const restored = parse(await readFile(path, 'utf8'));
    assert.deepEqual(restored.oauth['model-alias'].codex, []); assert.deepEqual(restored.oauth.settings.codex, []);
    assert.deepEqual(restored.access['api-keys'], [client]);
    const response = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${client}` } });
    const rows = await response.json() as { data: { id: string }[] };
    assert.ok(rows.data.some((row) => row.id === source));
    // Reload is async; test alias removal without conflating config rollback with immediate runtime reload.
    let removed = !rows.data.some((row) => row.id === 'synthetic-server-role');
    for (let attempt = 0; !removed && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const result = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${client}` } });
      const listing = await result.json() as { data: { id: string }[] };
      removed = !listing.data.some((row) => row.id === 'synthetic-server-role');
    }
    assert.equal(removed, true);
    const artifact = await recordEvidence(root, 'server-profile-probe', { status: 'passed', sandbox,
      binaryRelease: supplied ? 'operator-supplied' : version, archiveSha256: supplied ? null : digest,
      sourceModel: source, checks: ['read-only native projection preserves config', 'single scoped PATCH',
        'native config migrated to canonical v8', '1M alias context', 'client key and routing preserved',
        'native catalogue alias visible', 'rollback config and runtime catalogue', 'original model retained', 'no completion request'] });
    console.log(`SERVER_PROFILE_PROBE OK evidence=${artifact}`);
  } finally {
    if (oldAdmin === undefined) delete process.env.PROFILE_PROBE_ADMIN; else process.env.PROFILE_PROBE_ADMIN = oldAdmin;
    if (oldClient === undefined) delete process.env.PROFILE_PROBE_CLIENT; else process.env.PROFILE_PROBE_CLIENT = oldClient;
  }
} catch (error) {
  // Only synthetic process data; output bounded and explicitly stripped of synthetic credential values.
  const clean = logs.replace(/SYNTHETIC_[A-Z_]+/g, '[synthetic]');
  const evidence = await recordEvidence(root, 'server-profile-probe', { status: 'failed', sandbox, error: String(error), nativeLog: clean });
  console.error(`SERVER_PROFILE_PROBE ERROR diagnostic=${evidence}`); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child?.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(killTimer); }
  } else if (exited) await exited;
}
