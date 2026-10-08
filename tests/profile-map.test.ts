import test from 'node:test';
import assert from 'node:assert/strict';
import { profileMapRows, profileMapText, renderProfileMap } from '../src/profile-map.ts';
import { validateConfiguration } from '../src/configuration.ts';
import { makeGateway, member } from './fixtures.ts';

test('profile map lists default, fallback, selectable efforts and role in configuration order', () => {
  const gateway = makeGateway({
    models: {
      primary: { ...member, name: 'Primary Model', thinkingLevelMap: { off: null, minimal: null, medium: null, xhigh: null, max: null } },
      backup: { ...member, name: 'Backup | Model' },
      plain: { ...member, reasoning: false },
    },
    profiles: {
      'profile-a': { members: ['primary'], fallback: 'backup', description: 'Main work' },
      'profile-b': { members: ['primary', 'backup'], effort: 'high' },
      'profile-c': { members: ['plain'] },
    },
  });
  const rows = profileMapRows('test-proxy', gateway);
  assert.deepEqual(rows.map((row) => row.profile), ['profile-a', 'profile-b', 'profile-c']);
  assert.deepEqual(rows[0], { profile: 'profile-a', default: 'Primary Model', fallback: 'Backup | Model', context: '200.000', efforts: 'low, high', usage: 'Main work' });
  assert.equal(rows[1].fallback, 'Backup | Model', 'second member is the fallback when none is declared');
  assert.equal(rows[1].efforts, 'solo high (effort fisso)');
  assert.equal(rows[2].fallback, 'nessuno');
  assert.equal(rows[2].efforts, 'nessuno');
  const text = renderProfileMap(rows);
  assert.match(text, /^\| Profilo \| Default \| Fallback \| Contesto \| Effort possibili \| Quando usarlo \|\n\|---\|---\|---\|---\|---\|---\|\n/);
  assert.match(text, /Backup \\\| Model/, 'pipes in names cannot break the table');
  assert.equal(text.split('\n').length, 5);
});

test('declared fallback is display-only and does not change derived capabilities', () => {
  const withFallback = makeGateway({ profiles: { role: { members: ['primary'], fallback: 'backup' } } });
  const without = makeGateway({ profiles: { role: { members: ['primary'] } } });
  assert.equal(profileMapRows('t', withFallback)[0].efforts, profileMapRows('t', without)[0].efforts);
  assert.throws(() => validateConfiguration({ schemaVersion: 1, connections: { x: { endpoint: 'http://127.0.0.1:8317', allowInsecureHttp: true,
    credential: { kind: 'env', name: 'CPA_TEST_KEY' }, profiles: { role: { members: ['primary'], fallback: '../x' } } } } }));
  assert.equal(renderProfileMap([]), 'Nessun profilo configurato.');
});
test('context uses Italian digit grouping', () => {
  const big = { ...member, contextWindow: 1048576, maxTokens: 65536 };
  const gateway = makeGateway({ models: { primary: big }, profiles: { role: { members: ['primary'] } } });
  assert.equal(profileMapRows('t', gateway)[0].context, '1.048.576');
});
test('shared text adds the provider/profile addressing hint only for the model-facing tool', () => {
  const gateway = makeGateway({ profiles: { 'profile-a': { members: ['primary'], description: 'Main work' } } });
  const plain = profileMapText([['cpa-vps', gateway]]);
  const hinted = profileMapText([['cpa-vps', gateway]], true);
  assert.ok(plain.startsWith('| Profilo |'));
  assert.match(hinted, /^### cpa-vps\n\nSeleziona un profilo con l'id `cpa-vps\/<Profilo>` \(esempio: `cpa-vps\/profile-a`\)\.\n\n\| Profilo \|/);
  assert.ok(hinted.endsWith(plain));
});
