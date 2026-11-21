/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// 正式建置版加入 CSP：只允許本站資源，不連線任何外部腳本、字型、追蹤或 API。
// （開發模式不加，因為 Vite 開發伺服器需要內嵌腳本）
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";

function cspPlugin(): Plugin {
  return {
    name: 'legaleye-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

// base: './' 讓建置結果可放在公司內網任意子路徑（例如 https://intranet/legal/）
export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    sourcemap: false,
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    globals: false,
  },
});
