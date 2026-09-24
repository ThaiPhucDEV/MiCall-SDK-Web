import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const LOGIN_API_PREFIX = '/api-portal';

function sdkPackageSource(packageName: string): string {
  return fileURLToPath(
    new URL(`../../packages/${packageName}/src/index.ts`, import.meta.url),
  );
}

export default defineConfig({
  resolve: {
    alias: {
      '@micall/core': sdkPackageSource('core'),
      '@micall/sipjs-browser': sdkPackageSource('sipjs-browser'),
      '@micall/call-screen': sdkPackageSource('call-screen'),
      '@mitek/webrtc': sdkPackageSource('sdk-web'),
    },
  },
  server: {
    proxy: {
      [LOGIN_API_PREFIX]: {
        target: 'https://api-portal-02.mipbx.vn',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api-portal/, ''),
      },
    },
  },
});
