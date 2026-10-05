import { validateConfiguration } from '../src/configuration.ts';
import type { Gateway } from '../src/schema.ts';

export const member = {
  contextWindow: 200000, maxTokens: 64000, input: ['text'], reasoning: true,
  cost: { input: 1, output: 4, cacheRead: 0.3, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsStore: false },
};
export function makeGateway(overrides: Record<string, unknown> = {}): Gateway {
  return validateConfiguration({ schemaVersion: 1, connections: { 'test-proxy': {
    endpoint: 'http://127.0.0.1:8317', allowInsecureHttp: true,
    credential: { kind: 'env', name: 'CPA_TEST_KEY' }, builtinCatalog: false,
    models: { primary: member, backup: { ...member, input: ['text', 'image'], cost: { input: 3, output: 2, cacheRead: 0.1, cacheWrite: 0 } } },
    profiles: { role: { members: ['primary', 'backup'], effort: 'inherit' } },
    ...overrides,
  } } }).connections['test-proxy'];
}
