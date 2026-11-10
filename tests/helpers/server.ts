// 테스트 공용 픽스처
// - server: 워커마다 하나 띄우는 연습용 목 채팅 서버(포트 0). 워커가 끝나면 닫는다.
// - page: 테스트마다 브라우저를 새로 띄워 쓰고 닫는다.
//   이유: 샌드박스용 --single-process Chromium 은 한 브라우저에서 두 번째 컨텍스트를 만들면 죽는다.
//   기본 page 픽스처는 테스트마다 새 컨텍스트를 만들기 때문에 여기서 바꿔 둔다(일반 환경에서도 그대로 동작).
import { test as base, type Page } from '@playwright/test';
import { fixtureUrl, startFixtureServer, type FixtureMode, type FixtureServer } from '../../src/index.js';

export const test = base.extend<{ page: Page; open: (mode: FixtureMode) => Promise<Page> }, { server: FixtureServer }>({
  server: [
    async ({}, use) => {
      const server = await startFixtureServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  page: async ({ playwright, browserName, launchOptions }, use) => {
    const browser = await playwright[browserName].launch(launchOptions);
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await use(page);
    } finally {
      await browser.close();
    }
  },

  // 픽스처 화면을 열어 준다: await open('buggy')
  open: async ({ page, server }, use) => {
    await use(async (mode) => {
      await page.goto(fixtureUrl(server, mode));
      return page;
    });
  },
});

export { expect } from '@playwright/test';
