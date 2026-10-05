import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeYaml, validateConfiguration, safeFailure, ProxyFault } from '../src/configuration.ts';

export async function assemblePrivate(configPath: string, destination: string, name = 'pi-cpa-proxy-personal', sourceRoot = fileURLToPath(new URL('..', import.meta.url))): Promise<void> {
  if (!/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(name) || name === 'pi-cpa-proxy') throw new ProxyFault('private_package_name_invalid');
  const config = await readFile(configPath, 'utf8');
  validateConfiguration(decodeYaml(config));
  try { await stat(destination); throw new ProxyFault('destination_already_exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const source = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await cp(join(sourceRoot, 'src'), join(destination, 'src'), { recursive: true });
  await cp(join(sourceRoot, 'LICENSE'), join(destination, 'LICENSE'));
  await cp(join(sourceRoot, 'README.md'), join(destination, 'README.md'));
  const { devDependencies: _dev, scripts: _scripts, repository: _repository, ...manifest } = source;
  await writeFile(join(destination, 'package.json'), JSON.stringify({ ...manifest, name, private: true,
    files: ['src', 'config.yaml', 'provenance.json', 'README.md', 'LICENSE'],
  }, null, 2) + '\n');
  await writeFile(join(destination, 'config.yaml'), config, { mode: 0o600 });
  await writeFile(join(destination, 'provenance.json'), JSON.stringify({
    publicPackage: source.name, engineVersion: source.version, schemaVersion: 1,
    configSha256: createHash('sha256').update(config).digest('hex'),
  }, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Usage: npm run bundle:private -- CONFIG.yaml OUTPUT_DIR [PACKAGE_NAME]\nExit: 0 ok, 2 invalid/build failure. Output directory must not exist.');
  else {
    try {
      const [configPath, destination, name] = process.argv.slice(2);
      if (!configPath || !destination) throw new ProxyFault('arguments_required');
      await assemblePrivate(resolve(configPath), resolve(destination), name);
      console.log('PRIVATE_BUNDLE OK private=true secrets=external');
    } catch (error) { console.error(`PRIVATE_BUNDLE ERROR ${safeFailure(error)} origin=scripts/assemble-private.ts recovery=validate_paths_and_config`); process.exitCode = 2; }
  }
}
