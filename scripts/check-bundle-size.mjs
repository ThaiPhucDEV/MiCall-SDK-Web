import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve('packages/sdk-web/dist/iife');
const maximumBytes = 1_500_000;
const files = await readOutputFiles(outputDirectory);

if (files === undefined) {
  console.warn('SKIPPED: IIFE bundle size belongs to M3. Run pnpm build:iife before this check.');
} else {
  const bundle = files.find((file) => file.endsWith('.iife.js'));

  if (bundle === undefined) {
    throw new Error(`IIFE bundle was not found in ${outputDirectory}. Run pnpm build:iife first.`);
  }

  const size = (await stat(resolve(outputDirectory, bundle))).size;
  if (size > maximumBytes) {
    throw new Error(`IIFE bundle is ${size} bytes; budget is ${maximumBytes} bytes.`);
  }
}

async function readOutputFiles(directory) {
  try {
    return await readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

function hasErrorCode(error, expectedCode) {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  );
}
