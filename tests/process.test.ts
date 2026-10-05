import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { command, commandOutcome } from '../scripts/process.ts';

test('probe command outcome retains failure status and separated diagnostic streams', async () => {
  const result = await commandOutcome(process.execPath, ['-e', "process.stdout.write('fixture-out');process.stderr.write('fixture-err');process.exit(7)"], { cwd: tmpdir() });
  assert.equal(result.code, 7); assert.equal(result.stdout, 'fixture-out'); assert.equal(result.stderr, 'fixture-err'); assert.equal(result.timedOut, false);
});
test('probe command rejects unsuccessful invocation with actual subprocess status', async () => {
  await assert.rejects(() => command(process.execPath, ['-e', 'process.exit(3)'], { cwd: tmpdir() }), /code=3/);
  await assert.rejects(() => commandOutcome('/nonexistent-synthetic-command', [], { cwd: tmpdir() }), /ENOENT/);
});
test('probe command deadline is distinguished from ordinary failures', async () => {
  const result = await commandOutcome(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), timeoutMs: 100 });
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0); assert.ok(result.signal);
});
