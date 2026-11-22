import { defineConfig } from '@playwright/test';

// 響應式回歸測試：使用本機已安裝的 Microsoft Edge（不需另外下載瀏覽器）。
// 先執行 npm run build，再執行 npm run test:e2e。
const touch = { hasTouch: true, isMobile: true };

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    channel: 'msedge',
    baseURL: 'http://localhost:4173/',
    acceptDownloads: true,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'phone-390x844', use: { viewport: { width: 390, height: 844 }, ...touch, deviceScaleFactor: 2 } },
    { name: 'phone-landscape-844x390', use: { viewport: { width: 844, height: 390 }, ...touch, deviceScaleFactor: 2 } },
    { name: 'phone-narrow-360x740', use: { viewport: { width: 360, height: 740 }, ...touch, deviceScaleFactor: 2 } },
    { name: 'tablet-820x1180', use: { viewport: { width: 820, height: 1180 }, ...touch } },
    { name: 'tablet-landscape-1180x820', use: { viewport: { width: 1180, height: 820 }, ...touch } },
    { name: 'desktop-1440x900', use: { viewport: { width: 1440, height: 900 } } },
  ],
});
