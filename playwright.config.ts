// 테스트 설정.
// - IMEPLAY_BROWSERS (쉼표 구분, 기본 chromium): 어떤 브라우저 프로젝트를 돌릴지. CI 는 chromium,firefox,webkit.
// - IMEPLAY_CHROMIUM_ARGS: Chromium 실행 인자. 샌드박스에서는 "--single-process --no-zygote".
import { defineConfig, type PlaywrightTestProject } from '@playwright/test';
import { resolveLaunchOptions } from './src/launch.js';

const browsers = (process.env.IMEPLAY_BROWSERS ?? 'chromium')
  .split(',')
  .map((s) => s.trim())
  .filter((s): s is 'chromium' | 'firefox' | 'webkit' => s === 'chromium' || s === 'firefox' || s === 'webkit');

// 브라우저가 필요 없는 테스트(순수 함수·CLI 자식 프로세스·패키징)는 한 번만 돈다.
const UNIT = /[\\/](korean-steps|judge|cli|package)\.spec\.ts$/;

const projects: PlaywrightTestProject[] = [{ name: 'unit', testDir: './tests', testMatch: UNIT }];
for (const browserName of browsers) {
  const launchOptions = browserName === 'chromium' ? resolveLaunchOptions(process.env) : {};
  // 라이브러리 테스트: 테스트마다 브라우저를 새로 띄운다(tests/helpers/server.ts).
  projects.push({ name: browserName, testDir: './tests', testIgnore: UNIT, use: { browserName, launchOptions } });
  // 사용자 예시: README 와 같은 코드(@playwright/test 기본 page). 한 프로젝트에 테스트 하나라 컨텍스트도 하나다.
  projects.push({ name: `example-${browserName}`, testDir: './examples', use: { browserName, launchOptions } });
}

export default defineConfig({
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects,
});
