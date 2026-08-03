import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'dist');

// The root dashboard runs entirely in the browser. Do not copy runtime data
// or .env files into the public deployment bundle.
const assets = ['index.html', 'web', 'src', 'config', 'models'];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const asset of assets) {
  await cp(path.join(rootDir, asset), path.join(outputDir, asset), {
    recursive: true,
  });
}

console.log(`Static dashboard prepared in ${path.relative(rootDir, outputDir)}.`);
