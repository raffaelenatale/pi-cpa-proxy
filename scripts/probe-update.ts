import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, cp, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { assemblePrivate } from './assemble-private.ts';
import { command, commandOutcome, isolatedEnvironment, recordEvidence } from './process.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'pi-cpa-update-'));
const remotes = join(sandbox, 'remotes');
const server = createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_UPDATE');
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const configFor = (revision: string, contextWindow: number) => ({ schemaVersion: 1, revision, connections: { 'test-cpa': {
  endpoint, allowInsecureHttp: true, builtinCatalog: false, credential: { kind: 'env', name: 'CPA_TEST_KEY' },
  models: { 'test-model': { contextWindow, maxTokens: 16000, reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } },
} } });
const commonEnv = {
  CPA_TEST_KEY: 'SYNTHETIC_UPDATE',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://cpa-test.invalid/',
};
async function git(cwd: string, ...args: string[]) { return command('git', args, { cwd }); }
async function initialiseRepo(work: string, remote: string) {
  await git(work, 'init', '-b', 'main');
  await git(work, 'config', 'user.name', 'Synthetic test');
  await git(work, 'config', 'user.email', 'test@example.invalid');
  await git(work, 'add', '.'); await git(work, 'commit', '-m', 'synthetic release one');
  await git(work, 'tag', 'probe-v1');
  await mkdir(join(remote, '..'), { recursive: true });
  await git(work, 'clone', '--bare', work, remote);
  await git(work, 'remote', 'add', 'origin', remote);
}
const recoveryEvidence: Record<string, unknown>[] = [];
try {
  const publicWork = join(sandbox, 'public-work'), privateWork = join(sandbox, 'private-work');
  await mkdir(publicWork, { recursive: true });
  for (const item of ['src', 'README.md', 'LICENSE']) await cp(join(root, item), join(publicWork, item), { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  delete manifest.devDependencies; delete manifest.scripts;
  manifest.version = '0.0.1';
  await writeFile(join(publicWork, 'package.json'), JSON.stringify(manifest, null, 2));
  const input = join(sandbox, 'private-config.yaml');
  await writeFile(input, stringify(configFor('one', 100000)));
  await assemblePrivate(input, privateWork, 'pi-cpa-proxy-personal', publicWork);
  await initialiseRepo(publicWork, join(remotes, 'synthetic', 'public'));
  await initialiseRepo(privateWork, join(remotes, 'synthetic', 'private'));

  const publicOne = (await git(publicWork, 'rev-parse', 'HEAD')).trim();
  const privateOne = (await git(privateWork, 'rev-parse', 'HEAD')).trim();
  const publicEnv = isolatedEnvironment(join(sandbox, 'public-home'), commonEnv);
  const privateEnv = isolatedEnvironment(join(sandbox, 'private-home'), commonEnv);
  const pubSource = 'git:https://cpa-test.invalid/synthetic/public';
  const privateSource = 'git:https://cpa-test.invalid/synthetic/private';
  const pubConfigPath = join(publicEnv.PI_CODING_AGENT_DIR!, 'pi-cpa-proxy', 'config.yaml');
  const privateOverridePath = join(privateEnv.PI_CODING_AGENT_DIR!, 'pi-cpa-proxy', 'config.yaml');
  await mkdir(join(pubConfigPath, '..'), { recursive: true }); await mkdir(join(privateOverridePath, '..'), { recursive: true });
  const userConfig = stringify(configFor('user-owned', 250000));
  const override = 'connections:\n  test-cpa:\n    timeoutMs: 2000\n';
  await writeFile(pubConfigPath, userConfig); await writeFile(privateOverridePath, override);
  const preservedSettings = { defaultProvider: 'test-cpa', defaultModel: 'test-model', defaultThinkingLevel: 'off', quietStartup: true };
  for (const env of [publicEnv, privateEnv]) await writeFile(join(env.PI_CODING_AGENT_DIR!, 'settings.json'), JSON.stringify(preservedSettings));
  await command('pi', ['install', pubSource], { cwd: sandbox, env: publicEnv, timeoutMs: 120000 });
  await command('pi', ['install', privateSource], { cwd: sandbox, env: privateEnv, timeoutMs: 120000 });
  const publicInstalled = join(publicEnv.PI_CODING_AGENT_DIR!, 'git', 'cpa-test.invalid', 'synthetic', 'public');
  const privateInstalled = join(privateEnv.PI_CODING_AGENT_DIR!, 'git', 'cpa-test.invalid', 'synthetic', 'private');
  assert.equal(JSON.parse(await readFile(join(publicInstalled, 'package.json'), 'utf8')).version, '0.0.1');
  assert.match(await readFile(join(privateInstalled, 'config.yaml'), 'utf8'), /revision: one/);

  manifest.version = '0.0.2';
  await writeFile(join(publicWork, 'package.json'), JSON.stringify(manifest, null, 2));
  await git(publicWork, 'add', '.'); await git(publicWork, 'commit', '-m', 'synthetic release two'); await git(publicWork, 'push', 'origin', 'main');
  await writeFile(input, stringify(configFor('two', 1000000)));
  const nextBundle = join(sandbox, 'next-bundle');
  await assemblePrivate(input, nextBundle, 'pi-cpa-proxy-personal', publicWork);
  for (const item of ['src', 'README.md', 'LICENSE', 'package.json', 'config.yaml', 'provenance.json']) await cp(join(nextBundle, item), join(privateWork, item), { recursive: true });
  await git(privateWork, 'add', '.'); await git(privateWork, 'commit', '-m', 'synthetic release two'); await git(privateWork, 'push', 'origin', 'main');
  await command('pi', ['update', '--extensions'], { cwd: sandbox, env: publicEnv, timeoutMs: 120000 });
  await command('pi', ['update', '--extensions'], { cwd: sandbox, env: privateEnv, timeoutMs: 120000 });
  assert.equal(JSON.parse(await readFile(join(publicInstalled, 'package.json'), 'utf8')).version, '0.0.2');
  assert.equal(JSON.parse(await readFile(join(privateInstalled, 'package.json'), 'utf8')).version, '0.0.2');
  assert.equal(await readFile(pubConfigPath, 'utf8'), userConfig);
  assert.equal(await readFile(privateOverridePath, 'utf8'), override);
  assert.match(await readFile(join(privateInstalled, 'config.yaml'), 'utf8'), /revision: two/);
  const publicTwo = (await git(publicWork, 'rev-parse', 'HEAD')).trim();
  const privateTwo = (await git(privateWork, 'rev-parse', 'HEAD')).trim();
  const listing = await command('pi', ['--no-context-files', '--no-skills', '--no-prompt-templates', '--list-models', 'test-cpa'], { cwd: sandbox, env: privateEnv });
  assert.match(listing, /test-model/); assert.match(listing, /1M/);
  const listingArgs = ['--no-context-files', '--no-skills', '--no-prompt-templates', '--list-models', 'test-cpa'];
  async function configUnchanged() {
    assert.equal(await readFile(pubConfigPath, 'utf8'), userConfig);
    assert.equal(await readFile(privateOverridePath, 'utf8'), override);
    for (const env of [publicEnv, privateEnv]) {
      const settings = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8'));
      for (const [key, value] of Object.entries(preservedSettings)) assert.equal(settings[key], value);
    }
  }
  for (const [distribution, work, installed, source, env, one, two] of [
    ['public', publicWork, publicInstalled, pubSource, publicEnv, publicOne, publicTwo],
    ['private', privateWork, privateInstalled, privateSource, privateEnv, privateOne, privateTwo],
  ] as const) {
    const remote = join(remotes, 'synthetic', distribution);
    // Changing a configured ref must reconcile the existing checkout without duplicate package entries.
    await command('pi', ['install', `${source}@probe-v1`], { cwd: sandbox, env, timeoutMs: 120000 });
    assert.equal((await git(installed, 'rev-parse', 'HEAD')).trim(), one);
    const pinnedSettings = JSON.parse(await readFile(join(env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8'));
    assert.equal(pinnedSettings.packages.length, 1);
    assert.equal(typeof pinnedSettings.packages[0] === 'string' ? pinnedSettings.packages[0] : pinnedSettings.packages[0].source, `${source}@probe-v1`);
    await command('pi', ['update', '--extensions'], { cwd: sandbox, env, timeoutMs: 120000 });
    assert.equal((await git(installed, 'rev-parse', 'HEAD')).trim(), one, 'tag must not advance to main');
    if (distribution === 'private') assert.match(await readFile(join(installed, 'config.yaml'), 'utf8'), /revision: one/);
    await command('pi', ['install', `${source}@${two}`], { cwd: sandbox, env, timeoutMs: 120000 });
    await command('pi', ['update', '--extensions'], { cwd: sandbox, env, timeoutMs: 120000 });
    assert.equal((await git(installed, 'rev-parse', 'HEAD')).trim(), two);
    await configUnchanged();

    // Remove remote temporarily, with restoration even on assertion failure.
    await command('pi', ['install', source], { cwd: sandbox, env, timeoutMs: 120000 });
    const primedListing = await command('pi', listingArgs, { cwd: sandbox, env });
    assert.match(primedListing, /test-model/);
    const originalSettings = await readFile(join(env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8');
    const hiddenRemote = `${remote}.unavailable`;
    let unavailable;
    await rename(remote, hiddenRemote);
    try { unavailable = await commandOutcome('pi', ['update', '--extensions'], { cwd: sandbox, env, timeoutMs: 30000 }); }
    finally { await rename(hiddenRemote, remote); }
    assert.equal(unavailable.timedOut, false);
    assert.notEqual(unavailable.code, 0);
    assert.equal((await git(installed, 'rev-parse', 'HEAD')).trim(), two);
    assert.equal(await readFile(join(env.PI_CODING_AGENT_DIR!, 'settings.json'), 'utf8'), originalSettings);
    const fallbackListing = await command('pi', [...listingArgs, '--offline'], { cwd: sandbox, env });
    assert.match(fallbackListing, /test-model/);
    await configUnchanged();

    // Invalid root manifest deterministically fails the dependency-install phase AFTER checkout reset.
    // npm may accept missing/malformed file-link dependencies, so those are not valid failure injectors.
    const goodManifestText = await readFile(join(work, 'package.json'), 'utf8');
    const goodManifest = JSON.parse(goodManifestText);
    await writeFile(join(work, 'package.json'), '{ INVALID_SYNTHETIC_RELEASE_MANIFEST');
    await git(work, 'add', '.'); await git(work, 'commit', '-m', 'synthetic invalid manifest release'); await git(work, 'push', 'origin', 'main');
    const broken = (await git(work, 'rev-parse', 'HEAD')).trim();
    const failed = await commandOutcome('pi', ['update', '--extensions'], { cwd: sandbox, env, timeoutMs: 120000 });
    recoveryEvidence.push({ phase: 'dependencyFailureObserved', distribution, code: failed.code, stdout: failed.stdout.slice(-2000), stderr: failed.stderr.slice(-2000) });
    assert.equal(failed.timedOut, false); assert.notEqual(failed.code, 0);
    assert.equal((await git(installed, 'rev-parse', 'HEAD')).trim(), broken, 'Pi currently resets before dependency installation');
    const marker = join(installed, '..', `.${distribution}.pi-update-incomplete`);
    assert.ok((await stat(marker)).isFile());
    await configUnchanged();
    // Explicit pin known-good commit repairs dependencies, including after git clean removed node_modules.
    await command('pi', ['install', `${source}@${two}`], { cwd: sandbox, env, timeoutMs: 120000 });
    assert.equal((await git(installed, 'rev-parse', 'HEAD')).trim(), two);
    await assert.rejects(() => stat(marker), /ENOENT/);
    const restoredListing = await command('pi', listingArgs, { cwd: sandbox, env });
    assert.match(restoredListing, /test-model/);
    if (distribution === 'private') {
      assert.match(restoredListing, /1M/);
      assert.match(await readFile(join(installed, 'config.yaml'), 'utf8'), /revision: two/);
    }
    await configUnchanged();
    // Publish a corrected synthetic default branch and deliberately return to the moving update channel.
    await writeFile(join(work, 'package.json'), JSON.stringify({ ...goodManifest, version: '0.0.4' }, null, 2));
    await git(work, 'add', '.'); await git(work, 'commit', '-m', 'synthetic dependency recovery release'); await git(work, 'push', 'origin', 'main');
    await command('pi', ['install', source], { cwd: sandbox, env, timeoutMs: 120000 });
    await command('pi', ['update', '--extensions'], { cwd: sandbox, env, timeoutMs: 120000 });
    assert.equal(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).version, '0.0.4');
    await configUnchanged();
    const correctedCommit = (await git(work, 'rev-parse', 'HEAD')).trim();
    const goodEntry = await readFile(join(work, 'src', 'entry.ts'), 'utf8');
    await writeFile(join(work, 'src', 'entry.ts'), "export default function () { throw new Error('synthetic_bad_extension_factory'); }\n");
    await git(work, 'add', '.'); await git(work, 'commit', '-m', 'synthetic runtime defect release'); await git(work, 'push', 'origin', 'main');
    const runtimeUpdate = await commandOutcome('pi', ['update', '--extensions'], { cwd: sandbox, env, timeoutMs: 120000 });
    assert.equal(runtimeUpdate.code, 0, 'package update does not validate extension runtime');
    const runtimeLoad = await commandOutcome('pi', listingArgs, { cwd: sandbox, env, timeoutMs: 30000 });
    assert.doesNotMatch(runtimeLoad.stdout, /test-model/);
    // --list-models may exit 0 and hide factory error detail; model-presence assertion is the gate.
    await configUnchanged();
    await command('pi', ['install', `${source}@${correctedCommit}`], { cwd: sandbox, env, timeoutMs: 120000 });
    const runtimeRecovered = await command('pi', listingArgs, { cwd: sandbox, env });
    assert.match(runtimeRecovered, /test-model/);
    await configUnchanged();
    // Restore the synthetic work source for retained sandbox inspection; remain pinned to verified good commit.
    await writeFile(join(work, 'src', 'entry.ts'), goodEntry);
    recoveryEvidence.push({ distribution, tagPinned: true, commitPinned: true, identityDeduplicated: true,
      remoteUnavailableExit: unavailable.code, remoteFailureRetainedCheckout: true, cachedOfflineLoad: true,
      dependencyFailureExit: failed.code, dependencyFailureAdvancedCheckout: true, incompleteMarkerPresent: true,
      knownGoodCommitRollback: true, dependenciesRepaired: true, correctedBranchRecovery: true,
      runtimeDefectUpdateExit: runtimeUpdate.code, runtimeDefectLoadExit: runtimeLoad.code,
      runtimeDefectDetectedByMissingModel: true, runtimeDefectRollbackVerified: true,
      configBytePreserved: true, defaultsPreserved: true, goodReleaseCommit: two,
      runtimeDiagnostic: { stdout: runtimeLoad.stdout.slice(-2000), stderr: runtimeLoad.stderr.slice(-2000) },
      failures: { remote: { stdout: unavailable.stdout.slice(-2000), stderr: unavailable.stderr.slice(-2000) },
        dependency: { stdout: failed.stdout.slice(-2000), stderr: failed.stderr.slice(-2000) } } });
  }
  const evidence = await recordEvidence(root, 'update-probe', { status: 'passed', sandbox, pi: (await command('pi', ['--version'], { cwd: sandbox, env: publicEnv })).trim(), transport: 'Git URL rewritten to local bare repositories', checks: ['public engine 0.0.1→0.0.2', 'public config byte-preserved', 'private engine 0.0.1→0.0.2', 'private bundled config one→two', 'private override byte-preserved', 'private installed extension exposes updated 1M model'], listing, recoveryEvidence,
    notVerified: ['private GitHub authentication', 'npm registry release/update', 'in-flight session reload', 'cross-platform CI', 'process termination/disk-full recovery', 'interrupted dependency installation', 'multiple package partial failure'] });
  console.log(`UPDATE_PROBE OK evidence=${evidence}`);
} catch (error) {
  const evidence = await recordEvidence(root, 'update-probe', { status: 'failed', sandbox, error: String(error), stack: error instanceof Error ? error.stack : undefined, recoveryEvidence });
  console.error(`UPDATE_PROBE ERROR origin=scripts/probe-update.ts recovery=inspect_synthetic_evidence diagnostic=${evidence}`);
  process.exitCode = 1;
} finally { server.closeAllConnections(); server.close(); }
