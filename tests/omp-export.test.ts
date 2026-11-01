import test from 'node:test';
import assert from 'node:assert/strict';
import { ompApiKey, ompModelEntry } from '../src/omp-export.ts';
import { deriveCatalogue } from '../src/catalogue.ts';
import { makeGateway } from './fixtures.ts';

test('credentials are exported as references omp resolves itself, never as values', () => {
  assert.equal(ompApiKey({ kind: 'env', name: 'CPA_TEST_KEY' }), 'CPA_TEST_KEY');
  assert.equal(ompApiKey({ kind: 'file', path: '/home/u/.config/pi-cpa/api-key' }), '!cat /home/u/.config/pi-cpa/api-key');
  assert.equal(ompApiKey({ kind: 'keychain', service: 'cpa', account: 'me' }), '!security find-generic-password -a me -s cpa -w');
});

test('a derived profile is exported with the shared modalities and the price ceiling of its members', () => {
  const models = deriveCatalogue('test-proxy', makeGateway(), [{ id: 'primary' }, { id: 'backup' }, { id: 'role' }]).models;
  const entry = ompModelEntry(models.find((model) => model.id === 'role')!);
  assert.deepEqual(entry.input, ['text']);
  assert.deepEqual(entry.cost, { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0 });
  assert.equal(entry.maxTokens, 64000);
});
