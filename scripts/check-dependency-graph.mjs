import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageNames = [
  '@micall/core',
  '@micall/sipjs-browser',
  '@micall/call-screen',
  '@mitek/webrtc',
  '@micall/react',
  '@micall/vue',
];

const directories = new Map([
  ['@micall/core', 'packages/core'],
  ['@micall/sipjs-browser', 'packages/sipjs-browser'],
  ['@micall/call-screen', 'packages/call-screen'],
  ['@mitek/webrtc', 'packages/sdk-web'],
  ['@micall/react', 'packages/react'],
  ['@micall/vue', 'packages/vue'],
]);
const graph = new Map();

for (const [name, directory] of directories) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies };
  graph.set(
    name,
    Object.keys(dependencies).filter((dependency) => directories.has(dependency)),
  );
}

const visited = new Set();
const visiting = new Set();

function visit(name, path) {
  if (visiting.has(name)) {
    throw new Error(`Workspace dependency cycle: ${[...path, name].join(' -> ')}`);
  }
  if (visited.has(name)) {
    return;
  }
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) {
    visit(dependency, [...path, name]);
  }
  visiting.delete(name);
  visited.add(name);
}

for (const name of packageNames) {
  visit(name, []);
}
