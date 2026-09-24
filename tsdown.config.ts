import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/index.ts',
  platform: 'neutral',
  target: 'es2022',
  format: 'esm',
  minify: true, // Nén và làm rối (mangle) mã nguồn để bảo vệ logic
  sourcemap: false, // TẮT sourcemap để ngăn dịch ngược về file TypeScript gốc
  dts: {
    sourcemap: false, // Tắt sourcemap cho cả file .d.ts
  },
  clean: true,
  deps: {
    neverBundle: true,
  },
});

