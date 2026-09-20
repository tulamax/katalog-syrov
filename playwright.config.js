// E2E: chromium + webkit, телефон 375×812 и десктоп 1280×800, статический сервер на 8080.
import { defineConfig } from '@playwright/test';

const BASE = 'http://127.0.0.1:8080';
const phone = { width: 375, height: 812 };
const desktop = { width: 1280, height: 800 };

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE,
    // SW не должен перехватывать запросы — иначе page.route не видит docs.google.com.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-phone', use: { browserName: 'chromium', viewport: phone, isMobile: true, hasTouch: true } },
    { name: 'chromium-desktop', use: { browserName: 'chromium', viewport: desktop } },
    { name: 'webkit-phone', use: { browserName: 'webkit', viewport: phone, isMobile: true, hasTouch: true } },
    { name: 'webkit-desktop', use: { browserName: 'webkit', viewport: desktop } },
  ],
  webServer: {
    // http-server — в devDependencies: npm run e2e ничего не тянет из сети.
    command: 'npx http-server -p 8080 -c-1 .',
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
