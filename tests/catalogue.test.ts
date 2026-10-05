import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCatalogue, entranceUrl, priceCeiling } from '../src/catalogue.ts';
import { makeGateway, member } from './fixtures.ts';

test('mixed alias conserves common capabilities and component-wise ceiling', () => {
  const result = deriveCatalogue('test-proxy', makeGateway(), [{ id: 'role' }]);
  const model = result.models[0];
  assert.equal(model.id, 'role');
  assert.equal(model.contextWindow, 200000);
  assert.equal(model.maxTokens, 64000);
  assert.deepEqual(model.input, ['text']);
  assert.deepEqual(model.cost, { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 });
  assert.equal((model.compat as { supportsDeveloperRole: boolean }).supportsDeveloperRole, false);
});
test('partial compat override cannot accidentally erase system-role safeguard', () => {
  const gateway = makeGateway({ profiles: { role: { members: ['primary', 'backup'], metadata: { compat: { supportsStrictMode: true } } } } });
  const model = deriveCatalogue('test-proxy', gateway, [{ id: 'role' }]).models[0];
  assert.equal((model.compat as { supportsDeveloperRole: boolean }).supportsDeveloperRole, false);
  assert.equal((model.compat as { supportsStrictMode: boolean }).supportsStrictMode, true);
});
test('profile effort override cannot re-enable unsupported member level', () => {
  const gateway = makeGateway({
    models: { primary: { ...member, thinkingLevelMap: { low: null } }, backup: member },
    profiles: { role: { members: ['primary', 'backup'], metadata: { thinkingLevelMap: { low: 'low' } } } },
  });
  assert.equal(deriveCatalogue('test-proxy', gateway, [{ id: 'role' }]).models[0].thinkingLevelMap?.low, null);
});
test('unknown models omitted rather than guessed at 128k or zero cost', () => {
  const result = deriveCatalogue('test-proxy', makeGateway(), [{ id: 'unknown' }]);
  assert.equal(result.models.length, 0); assert.equal(result.omitted, 1); assert.equal(result.missingProfiles, 1);
});
test('profiles absent from live catalogue are not synthesized as executable aliases', () => {
  assert.equal(deriveCatalogue('test-proxy', makeGateway(), [{ id: 'primary' }]).models.some((m) => m.id === 'role'), false);
});
test('filters and disabled entries apply without altering alias member resolution', () => {
  const gateway = makeGateway({ hidden: ['primary'], models: { primary: { ...member, enabled: false }, backup: member } });
  const ids = deriveCatalogue('test-proxy', gateway, [{ id: 'primary' }, { id: 'role' }]).models.map((m) => m.id);
  assert.deepEqual(ids, ['role']);
});
test('duplicate discovery IDs are deduplicated', () => {
  assert.equal(deriveCatalogue('test-proxy', makeGateway(), [{ id: 'primary' }, { id: 'primary' }]).models.length, 1);
});
test('cycles and inflated profile capabilities fail closed', () => {
  const gateway = makeGateway({ profiles: { alpha: { members: ['beta'] }, beta: { members: ['alpha'] } } });
  assert.throws(() => deriveCatalogue('test-proxy', gateway, [{ id: 'alpha' }]), /profile_reference_cycle/);
  for (const metadata of [{ contextWindow: 1000000 }, { maxTokens: 100000 }, { input: ['text', 'image'] }]) {
    assert.throws(() => deriveCatalogue('test-proxy', makeGateway({ profiles: { role: { members: ['primary', 'backup'], metadata } } }), [{ id: 'role' }]), /profile_exceeds_member_capabilities/);
  }
});
test('inherited effort marks unsupported intersection; fixed effort maps all levels', () => {
  const gateway = makeGateway({ models: { primary: { ...member, thinkingLevelMap: { low: 'low', medium: null, high: 'high' } }, backup: member } });
  assert.equal(deriveCatalogue('test-proxy', gateway, [{ id: 'role' }]).models[0].thinkingLevelMap?.medium, null);
  const fixed = makeGateway({ profiles: { role: { members: ['primary', 'backup'], effort: 'low' } } });
  assert.deepEqual(Object.values(deriveCatalogue('test-proxy', fixed, [{ id: 'role' }]).models[0].thinkingLevelMap!), Array(7).fill('low'));
});
test('reject fixed effort explicitly unsupported by a member', () => {
  const gateway = makeGateway({ models: { primary: { ...member, thinkingLevelMap: { low: null } }, backup: member }, profiles: { role: { members: ['primary', 'backup'], effort: 'low' } } });
  assert.throws(() => deriveCatalogue('test-proxy', gateway, [{ id: 'role' }]), /fixed_effort_unsupported/);
});
test('pricing ceilings follow every tier boundary across members', () => {
  const low = { input: 1, output: 4, cacheRead: 0.3, cacheWrite: 0 };
  const high = { input: 5, output: 8, cacheRead: 0.1, cacheWrite: 1 };
  assert.deepEqual(priceCeiling([{ ...low, tiers: [{ inputTokensAbove: 100, ...high }] }, { ...low, input: 3, tiers: [{ inputTokensAbove: 200, ...high, input: 9 }] }]), {
    input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0,
    tiers: [{ inputTokensAbove: 100, input: 5, output: 8, cacheRead: 0.3, cacheWrite: 1 }, { inputTokensAbove: 200, input: 9, output: 8, cacheRead: 0.1, cacheWrite: 1 }],
  });
});
test('profile image preprocessing keeps tightest known member bounds', () => {
  const gateway = makeGateway({ models: {
    primary: { ...member, input: ['text', 'image'], inputLimits: { images: { resize: { maxWidth: 2000, jpegQuality: 80 } } } },
    backup: { ...member, input: ['text', 'image'], inputLimits: { images: { resize: { maxWidth: 1600 }, maxPerMessage: 4 } } },
  } });
  const model = deriveCatalogue('test-proxy', gateway, [{ id: 'role' }]).models[0];
  assert.equal(model.inputLimits?.images?.resize?.maxWidth, 1600);
  assert.equal(model.inputLimits?.images?.resize?.jpegQuality, 80);
  assert.equal(model.inputLimits?.images?.maxPerMessage, 4);
});
test('transport suffixes respect API, not upstream owner', () => {
  assert.equal(entranceUrl('https://proxy.example/', 'openai-responses'), 'https://proxy.example/v1');
  assert.equal(entranceUrl('https://proxy.example/', 'anthropic-messages'), 'https://proxy.example');
  assert.equal(entranceUrl('https://proxy.example/', 'google-generative-ai'), 'https://proxy.example/v1beta');
});
