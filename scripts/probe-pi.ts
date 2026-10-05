import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { command, isolatedEnvironment, recordEvidence } from './process.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'pi-cpa-probe-'));
let adminRequests = 0;
const completionPayloads: Record<string, any>[] = [];
const fixturePath = join(sandbox, 'fixture.txt');
const fixtureText = 'SYNTHETIC_TOOL_READ_OK';
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/v0/management') || req.url?.startsWith('/v8/management')) { adminRequests++; res.writeHead(500); res.end(); return; }
  assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_PROBE');
  if (req.url === '/v1/models') {
    assert.equal(req.method, 'GET');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'sample-alias' }] })); return;
  }
  assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw); completionPayloads.push(payload);
  const needsTool = completionPayloads.length === 1;
  if (needsTool) assert.ok(payload.tools.some((tool: { function: { name: string } }) => tool.function.name === 'read'));
  else assert.match(JSON.stringify(payload.messages), /SYNTHETIC_TOOL_READ_OK/);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
    id: 'synthetic-agent', object: 'chat.completion.chunk', created: 1, model: payload.model,
    choices: [{ index: 0, delta, finish_reason }],
    ...(finish_reason ? { usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } } : {}),
  })}\n\n`);
  if (needsTool) {
    emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_probe_read', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: fixturePath }) } }] }, null);
    emit({}, 'tool_calls');
  } else {
    emit({ role: 'assistant', content: 'SYNTHETIC_' }, null);
    emit({ content: completionPayloads.length === 2 ? 'AGENT_OK' : 'RESUME_OK' }, null);
    emit({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  await writeFile(fixturePath, fixtureText + '\n');
  const env = isolatedEnvironment(join(sandbox, 'home'), { CPA_TEST_KEY: 'SYNTHETIC_PROBE' });
  const directory = join(env.PI_CODING_AGENT_DIR!, 'pi-cpa-proxy');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'config.yaml');
  const config = stringify({ schemaVersion: 1, connections: { 'synthetic-cpa': {
    endpoint, allowInsecureHttp: true, builtinCatalog: false, credential: { kind: 'env', name: 'CPA_TEST_KEY' },
    admin: { kind: 'manager-plus', endpoint, allowInsecureHttp: true, credential: { kind: 'env', name: 'NOT_SET_SYNTHETIC_ADMIN' } },
    serverAdmin: { kind: 'cli-proxy-api-v8', endpoint, allowInsecureHttp: true, credential: { kind: 'env', name: 'NOT_SET_SYNTHETIC_SERVER_ADMIN' } },
    models: { 'sample-alias': { contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, compat: { supportsDeveloperRole: false } } },
  } } });
  await writeFile(path, config, { mode: 0o600 });
  const packedName = (await command('npm', ['pack', '--pack-destination', sandbox], { cwd: root })).trim().split('\n').at(-1)!;
  const archive = join(sandbox, packedName);
  const inventory = await command('tar', ['-tzf', archive], { cwd: sandbox });
  assert.doesNotMatch(inventory, /package\/(?:tests|scripts|node_modules|config\.yaml|\.artifacts)/);
  await command('tar', ['-xzf', archive], { cwd: sandbox });
  const packaged = join(sandbox, 'package');
  await command('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: packaged, env, timeoutMs: 120000 });
  const args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', packaged, '--list-models', 'synthetic-cpa'];
  const output = await command('pi', args, { cwd: sandbox, env });
  assert.match(output, /sample-alias/); assert.match(output, /1M/); assert.doesNotMatch(output, /128K/);
  assert.equal(await readFile(path, 'utf8'), config);
  const offline = await command('pi', [...args, '--offline'], { cwd: sandbox, env });
  assert.match(offline, /sample-alias/);
  const emptyEnv = isolatedEnvironment(join(sandbox, 'empty-home'));
  const noConfig = await command('pi', [...args.slice(0, -2), '--list-models', 'synthetic-cpa'], { cwd: sandbox, env: emptyEnv });
  assert.doesNotMatch(noConfig, /sample-alias/);
  const sessions = join(sandbox, 'sessions');
  const agentArgs = [...args.slice(0, -2), '--mode', 'json', '--provider', 'synthetic-cpa', '--model', 'sample-alias',
    '--thinking', 'off', '--tools', 'read', '--session-dir', sessions, '--session-id', 'adapter-probe'];
  const parseEvents = (text: string): Record<string, any>[] => text.trim().split('\n').map((line) => JSON.parse(line));
  const agentOutput = await command('pi', [...agentArgs, 'Read the synthetic fixture using the read tool.'], { cwd: sandbox, env });
  const events = parseEvents(agentOutput);
  const toolEnd = events.find((event) => event.type === 'tool_execution_end');
  assert.equal(toolEnd?.toolName, 'read'); assert.equal(toolEnd?.isError, false);
  assert.match(JSON.stringify(toolEnd?.result), /SYNTHETIC_TOOL_READ_OK/);
  assert.ok(events.some((event) => event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta'));
  const lastAssistant = events.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
  assert.equal(lastAssistant?.stopReason, 'stop');
  assert.equal(lastAssistant?.content.find((block: { type: string }) => block.type === 'text')?.text, 'SYNTHETIC_AGENT_OK');
  assert.equal(completionPayloads.length, 2);
  const resumeArgs = [...args.slice(0, -2), '--mode', 'json', '--provider', 'synthetic-cpa', '--model', 'sample-alias',
    '--thinking', 'off', '--tools', 'read', '--session-dir', sessions, '--session', 'adapter-probe'];
  const resumedOutput = await command('pi', [...resumeArgs, 'Continue the synthetic conversation.'], { cwd: sandbox, env });
  const resumed = parseEvents(resumedOutput);
  const resumedAssistant = resumed.filter((event) => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
  assert.equal(resumedAssistant?.stopReason, 'stop');
  assert.equal(resumedAssistant?.content.find((block: { type: string }) => block.type === 'text')?.text, 'SYNTHETIC_RESUME_OK');
  assert.equal(completionPayloads.length, 3);
  assert.match(JSON.stringify(completionPayloads[2].messages), /SYNTHETIC_AGENT_OK/);
  assert.doesNotMatch(agentOutput + resumedOutput, /SYNTHETIC_PROBE/);
  assert.equal(await readFile(path, 'utf8'), config);
  assert.equal(adminRequests, 0);
  const evidence = await recordEvidence(root, 'pi-probe', { status: 'passed', sandbox,
    validationKind: 'real-pi-synthetic-gateway', productionGatewayCertification: false,
    checks: ['public tarball allowlist', 'CLI loads packed native provider', '1M alias metadata', 'offline raw cache',
      'config unchanged', 'missing config nonblocking', 'configured admin never contacted',
      'real Pi read tool executed against synthetic fixture', 'tool result returned in native completion request',
      'CLI emits text stream deltas and final assistant text', 'persisted session resumes with prior tool/text history'],
    completionRequests: completionPayloads.length, inventory, output });
  console.log(`PI_PROBE OK evidence=${evidence}`);
} catch (error) {
  const evidence = await recordEvidence(root, 'pi-probe', { status: 'failed', sandbox, error: String(error) });
  console.error(`PI_PROBE ERROR origin=scripts/probe-pi.ts recovery=inspect_synthetic_evidence diagnostic=${evidence}`);
  process.exitCode = 1;
} finally {
  server.closeAllConnections(); server.close();
}
