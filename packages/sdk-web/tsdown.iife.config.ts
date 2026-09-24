import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/iife.ts',
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  outDir: 'dist/iife',
  minify: true, // Nén và làm rối toàn bộ bundle IIFE
  dts: false,
  sourcemap: false, // TẮT sourcemap
  clean: true,
  deps: {
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
});

