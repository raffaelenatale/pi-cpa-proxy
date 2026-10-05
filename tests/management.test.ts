import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, stat, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { managerSpec } from '../src/schema.ts';
import { managementStamp, openPriceAdministrator, toManagerPrice, type PriceTable } from '../src/management.ts';
import { runAdministration } from '../src/admin-command.ts';
import { makeGateway } from './fixtures.ts';
import { ProxyFault } from '../src/configuration.ts';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
const old = { prompt: 1, completion: 4, cache: 0.1, cacheRead: 0.1, source: 'manual' };
const desired = { input: 3, output: 8, cacheRead: 0.2, cacheWrite: 0, tiers: [{ inputTokensAbove: 100, input: 5, output: 12, cacheRead: 0.3, cacheWrite: 0 }] };
async function serverFixture() {
  let prices: PriceTable = { managed: old, untouched: { ...old, serviceTiers: [{ prompt: 7, completion: 9, cache: 0, mode: 'fast', serviceTier: 'priority', promptConfigured: true }] } };
  let puts = 0, auth = 0, mode = 'normal', badGet = false;
  const server = createServer(async (req, res) => {
    auth++;
    assert.equal(req.headers.authorization, 'Bearer ADMIN_SYNTHETIC');
    assert.equal(req.url, '/v0/management/model-prices');
    if (mode === 'unauthorized') { res.writeHead(401); res.end('Bearer PRIVATE_SERVER_BODY'); return; }
    if (mode === 'echo-secret') { res.end(JSON.stringify({ prices: { managed: { ...old, rawJson: 'ADMIN_SYNTHETIC' } } })); return; }
    if (mode === 'contract') { res.end(JSON.stringify({ prices: { managed: { ...old, unknownField: 'unsupported' } } })); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.invalid' }); res.end(); return; }
    if (req.method === 'GET') {
      if (badGet) { badGet = false; res.writeHead(503); res.end('PRIVATE'); return; }
      res.end(JSON.stringify({ prices })); return;
    }
    if (req.method === 'PUT') {
      puts++;
      let body = ''; for await (const chunk of req) body += chunk;
      if (mode === 'reject-put') { res.writeHead(409); res.end('private'); return; }
      prices = JSON.parse(body).prices;
      // Emulate Go omitempty and server timestamps in read-back.
      for (const price of Object.values(prices)) {
        price.updatedAtMs = Date.now();
        if (!price.cacheCreation) delete price.cacheCreation;
        if (!price.cacheRead) delete price.cacheRead;
      }
      if (mode === 'lose-ack') { req.socket.destroy(); return; }
      if (mode === 'verify-error') badGet = true;
      res.end(JSON.stringify({ prices })); return;
    }
    res.writeHead(405); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'cpa-admin-'));
  const config = managerSpec.parse({ kind: 'manager-plus', endpoint, allowInsecureHttp: true, credential: { kind: 'env', name: 'CPA_ADMIN_TEST' },
    allowPriceWrites: true, exclusivePriceWriter: true, prices: { managed: desired } });
  const previous = process.env.CPA_ADMIN_TEST; process.env.CPA_ADMIN_TEST = 'ADMIN_SYNTHETIC';
  return { config, directory, client: openPriceAdministrator(config, directory),
    table: () => structuredClone(prices), setTable: (value: PriceTable) => { prices = structuredClone(value); },
    mode: (value: string) => { mode = value; }, puts: () => puts, requests: () => auth,
    close: async () => { if (previous === undefined) delete process.env.CPA_ADMIN_TEST; else process.env.CPA_ADMIN_TEST = previous; server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}
const signal = () => AbortSignal.timeout(10000);

test('admin optional and mutation/exclusive writer consent are separate', () => {
  assert.equal(makeGateway().admin, undefined);
  assert.throws(() => managerSpec.parse({ kind: 'manager-plus', endpoint: 'https://example.invalid', credential: { kind: 'env', name: 'KEY' }, allowPriceWrites: true }), /full_replace_requires_exclusive_writer/);
  assert.throws(() => managerSpec.parse({ kind: 'manager-plus', endpoint: 'http://example.invalid', credential: { kind: 'env', name: 'KEY' } }));
});
test('price preview read-only and apply preserves unrelated advanced rules; rollback verified', async () => {
  const f = await serverFixture();
  try {
    const before = f.table();
    assert.equal((await f.client.inspect(signal())).compareAndSwap, false);
    const plan = await f.client.preview(signal());
    assert.deepEqual(plan.changed, ['managed']); assert.equal(f.puts(), 0);
    assert.deepEqual(plan.after.untouched, before.untouched);
    const id = await f.client.apply(plan, managementStamp(plan), signal());
    assert.equal(f.puts(), 1);
    assert.equal((await f.client.inspect(signal())).transaction, 'applied');
    assert.equal(f.table().managed.contextTiers?.[0].thresholdTokens, 100);
    assert.equal((await f.client.preview(signal())).changed.length, 0);
    await f.client.rollback(id, signal());
    assert.equal(managementStamp(f.table()), managementStamp(before));
    assert.equal((await f.client.inspect(signal())).transaction, 'rolled-back');
    const dirs = await readdir(f.directory); const path = join(f.directory, dirs[0], 'transaction.json');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path, 'utf8'), /ADMIN_SYNTHETIC/);
  } finally { await f.close(); }
});
test('writes disabled do not send PUT even with a valid approval', async () => {
  const f = await serverFixture();
  try {
    const client = openPriceAdministrator({ ...f.config, allowPriceWrites: false }, f.directory);
    const plan = await client.preview(signal());
    await assert.rejects(() => client.apply(plan, managementStamp(plan), signal()), /admin_writes_disabled/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('approval rejects tampered scope and content', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    await assert.rejects(() => f.client.apply(plan, 'wrong', signal()), /admin_approval_mismatch/);
    plan.after.untouched.prompt = 999;
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), signal()), /admin_approval_mismatch/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('concurrent edits since preview abort before PUT and rollback refuses later conflicts', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    const changed = f.table(); changed.untouched.prompt = 9; f.setTable(changed);
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), signal()), /admin_concurrent_change/);
    assert.equal(f.puts(), 0);
    const fresh = await f.client.preview(signal()); const id = await f.client.apply(fresh, managementStamp(fresh), signal());
    const subsequent = f.table(); subsequent.managed.prompt = 99; f.setTable(subsequent);
    await assert.rejects(() => f.client.rollback(id, signal()), /admin_rollback_conflict/);
    assert.equal(f.puts(), 1);
  } finally { await f.close(); }
});
for (const mode of ['lose-ack', 'verify-error', 'reject-put']) test(`uncertain mutation ${mode} retained and explicitly recoverable`, async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal()); f.mode(mode);
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), signal()), /admin_effects_uncertain/);
    f.mode('normal');
    assert.equal((await f.client.inspect(signal())).transaction, 'uncertain');
    const fresh = await f.client.preview(signal());
    if (fresh.changed.length) await assert.rejects(() => f.client.apply(fresh, managementStamp(fresh), signal()), /admin_transaction_open/);
    const id = await f.client.transactionId(); assert.ok(id);
    await f.client.rollback(id, signal());
    assert.equal((await f.client.inspect(signal())).transaction, 'rolled-back');
    assert.equal(f.table().managed.prompt, 1);
  } finally { await f.close(); }
});
for (const [mode, error] of [['unauthorized', 'admin_http_401'], ['contract', 'admin_contract_unsupported'], ['redirect', 'admin_network_failed'], ['echo-secret', 'admin_response_contains_credential']]) {
  test(`unsupported/unsafe API ${mode} fails redacted`, async () => {
    const f = await serverFixture();
    try { f.mode(mode); await assert.rejects(() => f.client.inspect(signal()), new RegExp(error)); assert.equal(f.puts(), 0); }
    finally { await f.close(); }
  });
}
test('local operation lock blocks apply before any mutation', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    const directory = join(f.directory, plan.target); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, 'operation.lock'), 'synthetic');
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), signal()), /admin_operation_busy/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('admin command cancel sends no PUT and headless never prompts', async () => {
  const f = await serverFixture();
  try {
    const choices = ['test-proxy', 'Preview / apply configured prices'];
    const notifications: string[] = [];
    const ctx = { hasUI: true, waitForIdle: async () => {}, ui: { select: async () => choices.shift(), confirm: async () => false,
      notify: (text: string) => notifications.push(text) } } as unknown as ExtensionCommandContext;
    const config = { schemaVersion: 1 as const, connections: { 'test-proxy': makeGateway({ admin: f.config }) } };
    await runAdministration(ctx, config, f.directory);
    assert.equal(f.puts(), 0); assert.ok(notifications.some((text) => text.includes('managed')));
    assert.ok(notifications.every((text) => !text.includes('ADMIN_SYNTHETIC')));
    await assert.rejects(() => runAdministration({ hasUI: false } as ExtensionCommandContext, config, f.directory), /admin_requires_explicit_ui_approval/);
  } finally { await f.close(); }
});
test('second successful transaction archives the first and rollback targets only latest', async () => {
  const f = await serverFixture();
  try {
    const first = await f.client.preview(signal());
    const firstId = await f.client.apply(first, managementStamp(first), signal());
    const client = openPriceAdministrator({ ...f.config, prices: { managed: { ...desired, input: 6 } } }, f.directory);
    const second = await client.preview(signal());
    const secondId = await client.apply(second, managementStamp(second), signal());
    assert.notEqual(secondId, firstId);
    const archived = await readFile(join(f.directory, first.target, `${firstId}.json`), 'utf8');
    assert.match(archived, /"state":"applied"/);
    await assert.rejects(() => client.rollback(firstId, signal()), /admin_rollback_reference_invalid/);
    await client.rollback(secondId, signal());
    assert.equal(f.table().managed.prompt, 3);
  } finally { await f.close(); }
});
test('rollback with lost acknowledgment can be retried by checking before snapshot', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal()); const id = await f.client.apply(plan, managementStamp(plan), signal());
    f.mode('lose-ack');
    await assert.rejects(() => f.client.rollback(id, signal()), /admin_rollback_uncertain/);
    f.mode('normal');
    assert.equal((await f.client.inspect(signal())).transaction, 'rolling-back');
    const putCount = f.puts();
    await f.client.rollback(id, signal());
    assert.equal(f.puts(), putCount);
    assert.equal((await f.client.inspect(signal())).transaction, 'rolled-back');
  } finally { await f.close(); }
});
test('journal write failure blocks mutation before PUT', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    await mkdir(join(f.directory, plan.target), { recursive: true, mode: 0o700 });
    await writeFile(join(f.directory, plan.target, 'transaction.json.lock'), 'busy');
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), signal()), /file_busy/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('changed config invalidates a previously approved plan', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    const client = openPriceAdministrator({ ...f.config, prices: { managed: { ...desired, input: 99 } } }, f.directory);
    await assert.rejects(() => client.apply(plan, managementStamp(plan), signal()), /admin_approval_mismatch/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('missing admin credential and invalid URL fail without secret output', async () => {
  const f = await serverFixture();
  try {
    const client = openPriceAdministrator({ ...f.config, credential: { kind: 'env', name: 'NONEXISTENT_SYNTHETIC_ADMIN_KEY' } }, f.directory);
    await assert.rejects(() => client.inspect(signal()), /admin_credential_missing/);
    assert.equal(f.requests(), 0);
    assert.throws(() => openPriceAdministrator({ ...f.config, endpoint: 'not a URL' }, f.directory), /admin_config_invalid/);
  } finally { await f.close(); }
});
test('interactive approval shows tier amounts and rechecks external config before write', async () => {
  const f = await serverFixture();
  try {
    const choices = ['test-proxy', 'Preview / apply configured prices'];
    const notices: string[] = []; let guarded = false;
    const ctx = { hasUI: true, waitForIdle: async () => {}, ui: { select: async () => choices.shift(), confirm: async () => true,
      notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
    const config = { schemaVersion: 1 as const, connections: { 'test-proxy': makeGateway({ admin: f.config }) } };
    await assert.rejects(() => runAdministration(ctx, config, f.directory, async () => {
      guarded = true; throw new ProxyFault('admin_config_changed_since_preview');
    }), /admin_config_changed_since_preview/);
    assert.equal(guarded, true); assert.equal(f.puts(), 0);
    assert.ok(notices.some((text) => text.includes('"thresholdTokens":100') && text.includes('"prompt":5')));
  } finally { await f.close(); }
});
test('symlinked target directory refuses journal and server mutations', { skip: process.platform === 'win32' }, async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    const other = await mkdtemp(join(tmpdir(), 'cpa-admin-untrusted-'));
    await symlink(other, join(f.directory, plan.target), 'dir');
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), signal()), /admin_directory_unsafe/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('already-cancelled apply sends no PUT', async () => {
  const f = await serverFixture();
  try {
    const plan = await f.client.preview(signal());
    await assert.rejects(() => f.client.apply(plan, managementStamp(plan), AbortSignal.abort()), /admin_aborted/);
    assert.equal(f.puts(), 0);
  } finally { await f.close(); }
});
test('snapshot hashing retains model IDs matching optional price field names', () => {
  assert.notEqual(managementStamp({ updatedAtMs: old }), managementStamp({}));
  assert.notEqual(managementStamp({ rawJson: old }), managementStamp({}));
  assert.equal(managementStamp({ managed: { ...old, updatedAtMs: 1 } }), managementStamp({ managed: { ...old, updatedAtMs: 2 } }));
});
test('manager mapping keeps strict threshold and explicit zero cache', () => {
  const mapped = toManagerPrice(desired);
  assert.equal(mapped.contextTiers?.[0].thresholdTokens, 100);
  assert.equal(mapped.contextTiers?.[0].cacheCreationConfigured, true);
  assert.equal(mapped.cacheCreation, 0);
});
