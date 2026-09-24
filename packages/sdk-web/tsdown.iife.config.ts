import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/iife.ts',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outDir: 'dist/iife',
  dts: false,
  sourcemap: true,
  clean: true,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
});
