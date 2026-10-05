import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverAdminSpec } from '../src/schema.ts';
import { openServerProfiles, profileStamp } from '../src/server-profiles.ts';
import { runServerProfileCommand } from '../src/profile-command.ts';
import { profileHttp } from '../src/admin-http.ts';
import { makeGateway } from './fixtures.ts';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

const primary = { name: 'origin-alpha', alias: 'unrelated', fork: true, 'force-mapping': false };
async function fixture() {
  let aliases: Record<string, Array<{ name: string; alias: string; fork?: boolean; 'force-mapping'?: boolean; 'display-name'?: string }>> = { codex: [primary], antigravity: [] };
  let settings: Record<string, Array<{ name: string; alias?: string; 'max-context-length'?: number }>> = { codex: [{ name: 'origin-alpha', alias: 'unrelated', 'max-context-length': 50000 }], antigravity: [] };
  let patches = 0, mode = 'normal', collision = false, responseInvalid = false;
  const paths: string[] = [];
  const unrelated = { 'api-keys': { secret: 'UPSTREAM_HIDDEN' }, routing: { strategy: 'fill-first', 'session-affinity': true }, requests: { payload: { rules: ['unchanged'] } } };
  const originalOther = JSON.stringify(unrelated);
  const server = createServer(async (req, res) => {
    paths.push(`${req.method} ${req.url}`);
    assert.ok(['/v8/management/config/oauth/model-alias', '/v8/management/config/oauth/settings', '/v8/management/config', '/v1/models'].includes(req.url!));
    assert.equal(req.headers.authorization, req.url === '/v1/models' ? 'Bearer CLIENT_SYNTHETIC' : 'Bearer ADMIN_SYNTHETIC');
    if (mode === 'unauthorized') { res.writeHead(401); res.end('PRIVATE_BODY'); return; }
    if (mode === 'missing') { res.writeHead(404); res.end('PRIVATE_BODY'); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.invalid' }); res.end(); return; }
    if (req.url === '/v1/models') {
      const ids = ['origin-alpha', 'origin-beta', ...(collision ? ['test-role'] : []),
        ...(mode === 'no-reload' ? [] : Object.values(aliases).flat().map((entry) => entry.alias))];
      res.end(JSON.stringify({ data: ids.map((id) => ({ id, object: 'model' })) })); return;
    }
    if (req.method === 'GET') {
      if (responseInvalid) { responseInvalid = false; res.writeHead(503); res.end(); return; }
      let data: unknown = req.url?.endsWith('/model-alias') ? aliases : settings;
      if (mode === 'secret') data = { codex: [{ name: 'ADMIN_SYNTHETIC', alias: 'unsafe' }] };
      if (mode === 'unknown') data = { codex: [{ name: 'origin-alpha', alias: 'unsafe', 'api-key': 'UPSTREAM_HIDDEN' }] };
      res.end(JSON.stringify(data)); return;
    }
    assert.equal(req.method, 'PATCH'); patches++;
    let text = ''; for await (const chunk of req) text += chunk;
    const update = JSON.parse(text);
    assert.deepEqual(Object.keys(update), ['oauth']);
    assert.deepEqual(Object.keys(update.oauth).sort(), ['model-alias', 'settings']);
    assert.doesNotMatch(text, /ADMIN_SYNTHETIC|CLIENT_SYNTHETIC|UPSTREAM_HIDDEN|api-keys|routing|requests/);
    if (mode === 'reject') { res.writeHead(422); res.end('private'); return; }
    aliases = { ...aliases, ...update.oauth['model-alias'] };
    if (mode !== 'partial') settings = { ...settings, ...update.oauth.settings };
    if (mode === 'lose-ack') { req.socket.destroy(); return; }
    if (mode === 'verification-error') responseInvalid = true;
    res.end(JSON.stringify({ status: 'ok', 'config-version': 8 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'cpa-server-aliases-'));
  const config = serverAdminSpec.parse({ kind: 'cli-proxy-api-v8', endpoint, allowInsecureHttp: true,
    credential: { kind: 'env', name: 'PROFILE_ADMIN_TEST' }, allowProfileWrites: true, exclusiveConfigWriter: true, acceptLayoutMigration: true,
    aliases: { 'test-role': { channel: 'codex', model: 'origin-alpha', contextWindow: 1000000 } } });
  const gateway = makeGateway({ endpoint, credential: { kind: 'env', name: 'PROFILE_CLIENT_TEST' } });
  const previousAdmin = process.env.PROFILE_ADMIN_TEST, previousClient = process.env.PROFILE_CLIENT_TEST;
  process.env.PROFILE_ADMIN_TEST = 'ADMIN_SYNTHETIC'; process.env.PROFILE_CLIENT_TEST = 'CLIENT_SYNTHETIC';
  return { config, gateway, directory, client: openServerProfiles(config, gateway, directory), paths,
    snapshot: () => structuredClone({ aliases, settings }),
    setSnapshot: (value: { aliases: typeof aliases; settings: typeof settings }) => { aliases = structuredClone(value.aliases); settings = structuredClone(value.settings); },
    mode: (value: string) => { mode = value; }, collision: () => { collision = true; }, patches: () => patches,
    close: async () => {
      assert.equal(JSON.stringify(unrelated), originalOther);
      if (previousAdmin === undefined) delete process.env.PROFILE_ADMIN_TEST; else process.env.PROFILE_ADMIN_TEST = previousAdmin;
      if (previousClient === undefined) delete process.env.PROFILE_CLIENT_TEST; else process.env.PROFILE_CLIENT_TEST = previousClient;
      server.closeAllConnections(); server.close(); await once(server, 'close');
    } };
}
const signal = () => AbortSignal.timeout(20000);

test('server schema requires explicit exclusivity and layout consent; rejects unsupported routing or chains', () => {
  const base = { kind: 'cli-proxy-api-v8', endpoint: 'https://example.invalid', credential: { kind: 'env', name: 'KEY' } };
  assert.equal(serverAdminSpec.parse(base).allowProfileWrites, false);
  assert.throws(() => serverAdminSpec.parse({ ...base, allowProfileWrites: true }));
  assert.throws(() => serverAdminSpec.parse({ ...base, aliases: { role: { channel: 'codex', model: 'role', contextWindow: 1000 } } }));
  assert.throws(() => serverAdminSpec.parse({ ...base, aliases: { role: { channel: 'codex', model: 'origin-alpha', contextWindow: 1000, fallback: 'origin-beta' } } }));
});
test('publish with one scoped PATCH, preserves original rows; catalogue and rollback verify', async () => {
  const f = await fixture();
  try {
    const before = f.snapshot(); const plan = await f.client.preview(signal());
    assert.deepEqual(plan.changed, ['test-role']); assert.equal(f.patches(), 0);
    const id = await f.client.apply(plan, profileStamp(plan), signal());
    assert.equal(f.patches(), 1); assert.equal((await f.client.inspect(signal())).transaction, 'applied');
    assert.deepEqual(f.snapshot().aliases.codex[0], primary);
    assert.equal(f.snapshot().settings.codex[1]['max-context-length'], 1000000);
    assert.equal((await f.client.preview(signal())).changed.length, 0);
    const dirs = await readdir(f.directory); const text = await readFile(join(f.directory, dirs[0], 'transaction.json'), 'utf8');
    assert.doesNotMatch(text, /ADMIN_SYNTHETIC|CLIENT_SYNTHETIC|UPSTREAM_HIDDEN/);
    await f.client.rollback(id, signal());
    assert.deepEqual(f.snapshot(), before);
    assert.equal((await f.client.inspect(signal())).ownedAliases, 0);
    assert.ok(f.paths.every((path) => !path.includes('/api-keys') && path !== 'GET /v8/management/config'));
  } finally { await f.close(); }
});
test('aliases already configured are never silently taken over, even identical', async () => {
  const f = await fixture();
  try {
    const state = f.snapshot(); state.aliases.codex.push({ name: 'origin-alpha', alias: 'test-role', fork: true, 'force-mapping': false }); f.setSnapshot(state);
    await assert.rejects(() => f.client.preview(signal()), /profile_unowned_alias_collision/); assert.equal(f.patches(), 0);
  } finally { await f.close(); }
});
test('live alias collisions outside OAuth maps abort', async () => {
  const f = await fixture();
  try { f.collision(); await assert.rejects(() => f.client.preview(signal()), /profile_catalogue_alias_collision/); assert.equal(f.patches(), 0); }
  finally { await f.close(); }
});
test('uninitialized channel and missing upstream model fail closed', async () => {
  const f = await fixture();
  try {
    for (const [changes, error] of [[{ channel: 'claude' }, 'profile_channel_not_initialized'], [{ model: 'missing' }, 'profile_source_not_listed']] as const) {
      const config = serverAdminSpec.parse({ ...f.config, aliases: { 'test-role': { ...f.config.aliases['test-role'], ...changes } } });
      await assert.rejects(() => openServerProfiles(config, f.gateway, f.directory).preview(signal()), new RegExp(error));
    }
    assert.equal(f.patches(), 0);
  } finally { await f.close(); }
});
test('read-only config and tampered approved plans send no PATCH', async () => {
  const f = await fixture();
  try {
    const readOnly = openServerProfiles({ ...f.config, allowProfileWrites: false }, f.gateway, f.directory);
    const plan = await readOnly.preview(signal());
    await assert.rejects(() => readOnly.apply(plan, profileStamp(plan), signal()), /profile_writes_disabled/);
    const valid = await f.client.preview(signal()); valid.after.aliases.codex[0].name = 'origin-beta';
    await assert.rejects(() => f.client.apply(valid, profileStamp(valid), signal()), /profile_approval_mismatch/);
    assert.equal(f.patches(), 0);
  } finally { await f.close(); }
});
test('concurrent before change aborts; later owned edits block preview and rollback', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal());
    const edited = f.snapshot(); edited.settings.codex[0]['max-context-length'] = 99; f.setSnapshot(edited);
    await assert.rejects(() => f.client.apply(plan, profileStamp(plan), signal()), /profile_concurrent_change/);
    const fresh = await f.client.preview(signal()), id = await f.client.apply(fresh, profileStamp(fresh), signal());
    const later = f.snapshot(); later.settings.codex[1]['max-context-length'] = 77; f.setSnapshot(later);
    await assert.rejects(() => f.client.preview(signal()), /profile_owned_resource_changed/);
    await assert.rejects(() => f.client.rollback(id, signal()), /profile_rollback_conflict/);
    assert.equal(f.patches(), 1);
  } finally { await f.close(); }
});
for (const mode of ['lose-ack', 'verification-error', 'reject']) test(`uncertain ${mode} explicitly recovered`, async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()); f.mode(mode);
    await assert.rejects(() => f.client.apply(plan, profileStamp(plan), signal()), /profile_effects_uncertain/);
    f.mode('normal'); assert.equal((await f.client.inspect(signal())).transaction, 'uncertain');
    await assert.rejects(() => f.client.preview(signal()), /profile_transaction_open/);
    const id = await f.client.transactionId(); assert.ok(id); await f.client.rollback(id, signal());
    assert.equal((await f.client.inspect(signal())).transaction, 'rolled-back');
  } finally { await f.close(); }
});
test('unexpected partial server mutation is refused on rollback, not overwritten', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()); f.mode('partial');
    await assert.rejects(() => f.client.apply(plan, profileStamp(plan), signal()), /profile_effects_uncertain_profile_verification_failed/);
    f.mode('normal'); const id = await f.client.transactionId(); assert.ok(id);
    await assert.rejects(() => f.client.rollback(id, signal()), /profile_rollback_conflict/); assert.equal(f.patches(), 1);
  } finally { await f.close(); }
});
test('configuration match without catalogue reload remains uncertain', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()); f.mode('no-reload');
    await assert.rejects(() => f.client.apply(plan, profileStamp(plan), signal()), /profile_effects_uncertain_profile_catalogue_reload_unverified/);
    f.mode('normal'); const id = await f.client.transactionId(); assert.ok(id); await f.client.rollback(id, signal());
  } finally { await f.close(); }
});
for (const [mode, expected] of [['secret', 'admin_response_contains_credential'], ['unknown', 'profile_contract_unsupported'], ['unauthorized', 'admin_http_401'], ['missing', 'admin_http_404'], ['redirect', 'admin_network_failed']]) {
  test(`unsupported secret-free contract ${mode} rejected without PATCH`, async () => {
    const f = await fixture();
    try { f.mode(mode); await assert.rejects(() => f.client.preview(signal()), new RegExp(expected)); assert.equal(f.patches(), 0); }
    finally { await f.close(); }
  });
}
test('owned alias update with channel move and rollback of latest restores ownership', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()), firstId = await f.client.apply(plan, profileStamp(plan), signal());
    const updated = serverAdminSpec.parse({ ...f.config, aliases: { 'test-role': { channel: 'antigravity', model: 'origin-beta', contextWindow: 500000 } } });
    const client = openServerProfiles(updated, f.gateway, f.directory), next = await client.preview(signal());
    assert.deepEqual(next.channels, ['antigravity', 'codex']);
    const secondId = await client.apply(next, profileStamp(next), signal());
    assert.equal(f.snapshot().aliases.antigravity.length, 1);
    await assert.rejects(() => client.rollback(firstId, signal()), /profile_rollback_reference_invalid/);
    await client.rollback(secondId, signal());
    assert.equal((await client.inspect(signal())).ownedAliases, 1);
    assert.equal(f.snapshot().aliases.antigravity.length, 0);
    // Rollback does not undo the desired config, so next preview correctly proposes the move again.
    assert.deepEqual((await client.preview(signal())).changed, ['test-role']);
  } finally { await f.close(); }
});
test('removing an owned alias requires explicit rollback, not deletion through preview', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()); await f.client.apply(plan, profileStamp(plan), signal());
    const client = openServerProfiles({ ...f.config, aliases: {} }, f.gateway, f.directory);
    await assert.rejects(() => client.preview(signal()), /profile_removal_requires_rollback/);
  } finally { await f.close(); }
});
test('journal lock or already aborted operation sends no PATCH', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal());
    await assert.rejects(() => f.client.apply(plan, profileStamp(plan), AbortSignal.abort()), /admin_aborted/);
    await mkdir(join(f.directory, plan.target), { recursive: true, mode: 0o700 });
    await writeFile(join(f.directory, plan.target, 'transaction.json.lock'), 'busy');
    await assert.rejects(() => f.client.apply(plan, profileStamp(plan), signal()), /file_busy/); assert.equal(f.patches(), 0);
  } finally { await f.close(); }
});
test('cancelled UI and headless invocation never publish', async () => {
  const f = await fixture();
  try {
    const choices = ['test-proxy', 'Preview / publish server aliases']; const notices: string[] = [];
    const ctx = { hasUI: true, waitForIdle: async () => {}, ui: { select: async () => choices.shift(), confirm: async () => false,
      notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
    await runServerProfileCommand(ctx, { schemaVersion: 1, connections: { 'test-proxy': { ...f.gateway, serverAdmin: f.config } } }, f.directory);
    assert.ok(notices.some((text) => text.includes('test-role'))); assert.equal(f.patches(), 0);
    await assert.rejects(() => runServerProfileCommand({ hasUI: false } as ExtensionCommandContext, undefined, f.directory), /profile_requires_explicit_ui_approval/);
  } finally { await f.close(); }
});
test('native alias chains rejected even when source appears in catalogue', async () => {
  const f = await fixture();
  try {
    const config = serverAdminSpec.parse({ ...f.config, aliases: { 'test-role': { ...f.config.aliases['test-role'], model: 'unrelated' } } });
    await assert.rejects(() => openServerProfiles(config, f.gateway, f.directory).preview(signal()), /profile_source_is_alias/);
    assert.equal(f.patches(), 0);
  } finally { await f.close(); }
});
test('later unrelated OAuth edit permits owned update, but blocks full-snapshot rollback', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()), transaction = await f.client.apply(plan, profileStamp(plan), signal());
    const changed = f.snapshot(); changed.settings.codex[0]['max-context-length'] = 123; f.setSnapshot(changed);
    assert.equal((await f.client.preview(signal())).changed.length, 0);
    await assert.rejects(() => f.client.rollback(transaction, signal()), /profile_rollback_conflict/);
    assert.equal(f.patches(), 1);
  } finally { await f.close(); }
});
test('rollback ACK loss recovers without sending a duplicate PATCH', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.preview(signal()), transaction = await f.client.apply(plan, profileStamp(plan), signal());
    f.mode('lose-ack'); await assert.rejects(() => f.client.rollback(transaction, signal()), /profile_rollback_uncertain/);
    f.mode('normal'); const count = f.patches(); await f.client.rollback(transaction, signal());
    assert.equal(f.patches(), count); assert.equal((await f.client.inspect(signal())).transaction, 'rolled-back');
  } finally { await f.close(); }
});
test('fixed HTTP allowlist rejects full config reads and arbitrary writes', async () => {
  await assert.rejects(() => profileHttp('https://example.invalid', '/v8/management/config', 'synthetic', 1000, signal()), /admin_path_forbidden/);
  await assert.rejects(() => profileHttp('https://example.invalid', '/v8/management/config/api-keys', 'synthetic', 1000, signal()), /admin_path_forbidden/);
  await assert.rejects(() => profileHttp('https://example.invalid', '/v8/management/config', 'synthetic', 1000, signal(), { 'api-keys': [] }), /admin_patch_scope_forbidden/);
});
test('excluded credential, usage, quota and cooldown endpoints fail before any network request', async () => {
  const f = await fixture();
  try {
    const paths = ['/v8/management/credentials', '/v8/management/credentials/download',
      '/v8/management/credentials/status', '/v8/management/credentials/fields', '/v8/management/credentials/refresh',
      '/v8/management/observability/usage/api-keys', '/v8/management/routing/cooldown/reset',
      '/v8/management/config/access/api-keys', '/v8/management/config/api-keys',
      '/v8/management/requests/api-call', '/v8/management/plugins/example/quota', '/v8/management/oauth/auth-url'];
    for (const path of paths) {
      for (const body of [undefined, { auth_index: 'synthetic-index' }]) {
        await assert.rejects(() => profileHttp(f.config.endpoint, path, 'ADMIN_SYNTHETIC', 1000, signal(), body), /admin_path_forbidden/);
      }
    }
    assert.deepEqual(f.paths, []);
    assert.equal(f.patches(), 0);
  } finally { await f.close(); }
});
test('strict server config rejects excluded quota/key/cooldown consent flags', () => {
  const base = { kind: 'cli-proxy-api-v8', endpoint: 'https://example.invalid', credential: { kind: 'env', name: 'KEY' } };
  for (const field of ['allowCooldownReset', 'allowKeyWrites', 'quotaPolling']) {
    assert.throws(() => serverAdminSpec.parse({ ...base, [field]: true }));
  }
});
test('compatible primary/fallback group publishing, catalogue verification and atomic rollback', async () => {
  const f = await fixture();
  try {
    const before = f.snapshot();
    const configWithGroup = serverAdminSpec.parse({
      ...f.config,
      aliases: {},
      compatibleGroups: {
        'mixed-group': {
          primary: { channel: 'codex', model: 'origin-alpha' },
          fallback: { channel: 'antigravity', model: 'origin-beta' },
          contextWindow: 1000000,
        },
      },
    });
    const client = openServerProfiles(configWithGroup, f.gateway, f.directory);
    const plan = await client.preview(signal());
    assert.deepEqual(plan.changed, ['mixed-group']);
    assert.deepEqual(plan.channels.sort(), ['antigravity', 'codex']);
    const txId = await client.apply(plan, profileStamp(plan), signal());
    assert.equal(f.patches(), 1);
    const published = f.snapshot();
    assert.equal(published.aliases.codex.some((r) => r.alias === 'mixed-group' && r.name === 'origin-alpha'), true);
    assert.equal(published.aliases.antigravity.some((r) => r.alias === 'mixed-group' && r.name === 'origin-beta'), true);
    assert.equal(published.settings.codex.some((r) => r.alias === 'mixed-group' && r['max-context-length'] === 1000000), true);
    assert.equal(published.settings.antigravity.some((r) => r.alias === 'mixed-group' && r['max-context-length'] === 1000000), true);
    // Inspection reports compatiblePrimaryFallback enabled
    const status = await client.inspect(signal());
    assert.equal(status.compatiblePrimaryFallback, true);
    assert.equal(status.ownedAliases, 1);
    // Rollback restores initial snapshot without traces
    await client.rollback(txId, signal());
    assert.deepEqual(f.snapshot(), before);
    assert.equal((await client.inspect(signal())).ownedAliases, 0);
  } finally { await f.close(); }
});
test('compatible group rejects collisions with OAuth aliases and chains', () => {
  const base = {
    kind: 'cli-proxy-api-v8', endpoint: 'https://example.invalid', credential: { kind: 'env', name: 'KEY' },
    allowProfileWrites: true, exclusiveConfigWriter: true, acceptLayoutMigration: true,
  };
  // Collision with existing alias ID
  assert.throws(() => serverAdminSpec.parse({
    ...base,
    aliases: { 'same-id': { channel: 'codex', model: 'origin-alpha', contextWindow: 1000 } },
    compatibleGroups: {
      'same-id': {
        primary: { channel: 'codex', model: 'origin-alpha' },
        fallback: { channel: 'antigravity', model: 'origin-beta' },
        contextWindow: 1000,
      },
    },
  }), /compatible_group_collision_with_oauth_alias/);
  // Self-referencing model
  assert.throws(() => serverAdminSpec.parse({
    ...base,
    compatibleGroups: {
      'self-ref': {
        primary: { channel: 'codex', model: 'self-ref' },
        fallback: { channel: 'antigravity', model: 'origin-beta' },
        contextWindow: 1000,
      },
    },
  }), /compatible_group_chain_or_self_reference/);
});
