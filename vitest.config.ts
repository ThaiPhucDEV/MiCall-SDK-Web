import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@micall/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@micall/sipjs-browser': fileURLToPath(
        new URL('./packages/sipjs-browser/src/index.ts', import.meta.url),
      ),
      '@micall/call-screen': fileURLToPath(
        new URL('./packages/call-screen/src/index.ts', import.meta.url),
      ),
      '@mitek/webrtc': fileURLToPath(new URL('./packages/sdk-web/src/index.ts', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['packages/core/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'sipjs-browser',
          environment: 'node',
          include: ['packages/sipjs-browser/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'sdk-web',
          environment: 'node',
          include: ['packages/sdk-web/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'contract',
          environment: 'node',
          include: ['tests/contract/**/*.test.ts'],
        },
      },
    ],
  },
});
