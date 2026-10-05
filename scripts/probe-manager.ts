import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openPriceAdministrator, managementStamp, toManagerPrice, type PriceTable } from '../src/management.ts';
import { managerSpec } from '../src/schema.ts';
import { recordEvidence } from './process.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'manager-plus-probe-'));

let table: PriceTable = {
  'existing-model': {
    prompt: 1.0, completion: 2.0, cache: 0.1, cacheRead: 0.1, cacheCreation: 0.0,
    promptConfigured: true, completionConfigured: true, cacheReadConfigured: true, cacheCreationConfigured: true,
    source: 'preset', sourceModelId: 'upstream', rawJson: '{"notes":"retained"}', updatedAtMs: 1000,
  },
};

const adminKey = 'SYNTHETIC_MANAGER_ADMIN_PROBE';
let putCount = 0;
let getCount = 0;

const server = createServer(async (req, res) => {
  assert.equal(req.url, '/v0/management/model-prices');
  assert.equal(req.headers.authorization, `Bearer ${adminKey}`);
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    getCount++;
    res.end(JSON.stringify({ prices: table }));
    return;
  }

  if (req.method === 'PUT') {
    putCount++;
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body) as { prices: PriceTable };
    assert.ok(data.prices, 'PUT payload missing prices object');
    assert.doesNotMatch(body, new RegExp(adminKey), 'Payload must never echo admin key');
    // Simulate server transaction update and timestamps update
    table = structuredClone(data.prices);
    for (const item of Object.values(table)) {
      item.updatedAtMs = Date.now();
    }
    res.end(JSON.stringify({ prices: table }));
    return;
  }

  res.writeHead(405);
  res.end();
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const oldEnv = process.env.MANAGER_PROBE_KEY;
process.env.MANAGER_PROBE_KEY = adminKey;

try {
  const config = managerSpec.parse({
    kind: 'manager-plus',
    endpoint,
    allowInsecureHttp: true,
    credential: { kind: 'env', name: 'MANAGER_PROBE_KEY' },
    allowPriceWrites: true,
    exclusivePriceWriter: true,
    prices: {
      'managed-model': {
        input: 3.5,
        output: 10.0,
        cacheRead: 0.25,
        cacheWrite: 0.5,
        tiers: [{ inputTokensAbove: 200000, input: 5.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0.6 }],
      },
    },
  });

  const stateDir = join(sandbox, 'state');
  const admin = openPriceAdministrator(config, stateDir);

  // 1. Inspect contract & read-only state
  const initialInspect = await admin.inspect(AbortSignal.timeout(10000));
  assert.equal(initialInspect.priceRead, true);
  assert.equal(initialInspect.priceWriteEnabled, true);
  assert.equal(initialInspect.compareAndSwap, false);
  assert.equal(initialInspect.priceCount, 1);
  assert.equal(initialInspect.scopeCount, 1);
  assert.equal(initialInspect.transaction, 'none');

  // 2. Preview plan
  const plan = await admin.preview(AbortSignal.timeout(10000));
  assert.deepEqual(plan.changed, ['managed-model']);
  assert.equal(plan.before['existing-model'].prompt, 1.0);
  assert.equal(plan.after['existing-model'].prompt, 1.0);
  assert.equal(plan.after['managed-model'].prompt, 3.5);
  assert.equal(plan.after['managed-model'].contextTiers?.[0].thresholdTokens, 200000);

  // 3. Apply full-table PUT
  const approval = managementStamp(plan);
  const txId = await admin.apply(plan, approval, AbortSignal.timeout(15000));
  assert.equal(putCount, 1);
  assert.ok(txId, 'Transaction ID must be returned');

  // Verify server state preserved unrelated rows and metadata
  assert.equal(table['existing-model'].source, 'preset');
  assert.equal(table['existing-model'].rawJson, '{"notes":"retained"}');
  assert.equal(table['managed-model'].prompt, 3.5);
  assert.equal(table['managed-model'].contextTiers?.[0].thresholdTokens, 200000);

  // Status after apply
  const postApplyInspect = await admin.inspect(AbortSignal.timeout(10000));
  assert.equal(postApplyInspect.transaction, 'applied');
  assert.equal(postApplyInspect.priceCount, 2);

  // 4. Rollback latest transaction
  await admin.rollback(txId, AbortSignal.timeout(15000));
  assert.equal(putCount, 2);
  assert.equal(Object.keys(table).includes('managed-model'), false);
  assert.equal(table['existing-model'].prompt, 1.0);

  const postRollbackInspect = await admin.inspect(AbortSignal.timeout(10000));
  assert.equal(postRollbackInspect.transaction, 'rolled-back');
  assert.equal(postRollbackInspect.priceCount, 1);

  const evidence = await recordEvidence(root, 'manager-probe', {
    status: 'passed',
    validationKind: 'synthetic-loopback',
    realManagerCertification: false,
    sandbox,
    checks: [
      'GET status reports synthetic price table and CAS unavailable',
      'Preview reports managed-model delta without PUT',
      'Approved apply sends one full-table PUT',
      'Unrelated source/rawJson metadata retained',
      'Synthetic updated timestamps tolerated by verification',
      'Status reports applied and rolled-back transaction states',
      'Latest rollback removes introduced row and restores original rates',
      'PUT bodies do not contain the synthetic admin key',
    ],
    getCount,
    putCount,
  });

  console.log(`MANAGER_PROBE OK evidence=${evidence}`);
} catch (error) {
  const evidence = await recordEvidence(root, 'manager-probe', { status: 'failed', validationKind: 'synthetic-loopback', realManagerCertification: false, sandbox, error: String(error) });
  console.error(`MANAGER_PROBE ERROR origin=scripts/probe-manager.ts recovery=inspect_synthetic_evidence diagnostic=${evidence}`);
  process.exitCode = 1;
} finally {
  if (oldEnv === undefined) delete process.env.MANAGER_PROBE_KEY;
  else process.env.MANAGER_PROBE_KEY = oldEnv;
  server.closeAllConnections();
  server.close();
}
