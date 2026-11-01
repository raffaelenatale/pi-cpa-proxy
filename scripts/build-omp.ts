import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * One-file build of the omp extension. omp's extension host resolves neither `yaml`/`zod` from a
 * package's node_modules nor pi-ai subpaths, so dependencies are inlined and only pi-ai (provided
 * by the host) stays external. `nodePaths` lets a source tree without node_modules (a sandbox copy
 * of src/) resolve the dependencies from this repository.
 */
export async function buildOmpEntry(sourceRoot: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [join(sourceRoot, 'src', 'omp-entry.ts')], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    external: ['@earendil-works/*'], nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
    legalComments: 'none', logLevel: 'silent',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const outfile = resolve(process.argv[2] ?? join(root, 'dist', 'omp-entry.js'));
  await buildOmpEntry(root, outfile);
  console.log(`OMP_ENTRY OK ${outfile}`);
}
