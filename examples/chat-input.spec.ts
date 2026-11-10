// 사용자용 예시 — README "내 테스트에 넣기" 와 같은 코드.
// 실제 앱에서는 page.goto('/chat') 처럼 내 화면을 열면 된다. 여기서는 저장소 안의 연습용 목(mock) 채팅 화면을 쓴다.
// 실패 메시지를 보고 싶으면: IMEPLAY_EXAMPLE_MODE=buggy npx playwright test examples/
import { test } from '@playwright/test';
import { checkIme, expectSingleSubmit, startFixtureServer, type FixtureServer } from 'imeplay';

let server: FixtureServer;
test.beforeAll(async () => {
  server = await startFixtureServer();
});
test.afterAll(async () => {
  await server.close();
});

test('한국어 입력 후 Enter 는 한 번만 전송', async ({ page }) => {
  const mode = process.env.IMEPLAY_EXAMPLE_MODE ?? 'fixed';
  await page.goto(`${server.url}/chat.html?mode=${mode}`);
  const report = await checkIme(page, {
    input: '#prompt',
    text: '안녕하세요',
    profiles: 'auto',
    request: '**/api/chat',
  });
  expectSingleSubmit(report); // 실패 시: safari: SUBMIT_ON_IME_ENTER — sent ['안녕하세요'@ime-enter]
});
