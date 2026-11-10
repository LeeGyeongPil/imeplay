// AC-4: 합성 프로필 3종(chromium·firefox·safari 순서) 행렬.
// 합성 이벤트는 어느 브라우저에서나 dispatch 할 수 있으므로 모든 브라우저 프로젝트에서 같은 행렬을 확인한다.
import { checkIme, typeWithIme, type FixtureMode, type ImeEvent, type Profile } from '../src/index.js';
import { expect, test } from './helpers/server.js';

const EXPECTED: Record<FixtureMode, Record<'chromium' | 'firefox' | 'safari', 'PASS' | 'FAIL'>> = {
  buggy: { chromium: 'FAIL', firefox: 'FAIL', safari: 'FAIL' },
  'composing-only': { chromium: 'PASS', firefox: 'PASS', safari: 'FAIL' }, // isComposing 만 보면 Safari 에서 깨진다
  fixed: { chromium: 'PASS', firefox: 'PASS', safari: 'PASS' },
};
const PROFILES: Profile[] = ['chromium', 'firefox', 'safari'];

for (const mode of Object.keys(EXPECTED) as FixtureMode[]) {
  test(`${mode}: synthetic chromium·firefox·safari 행렬`, async ({ open }) => {
    const page = await open(mode);
    const reports = await checkIme(page, { input: '#prompt', text: '안녕', profiles: PROFILES });
    const got = Object.fromEntries(reports.map((r) => [r.profile, r.verdict === 'PASS' ? 'PASS' : 'FAIL']));
    expect(got).toEqual(EXPECTED[mode]);
    if (mode === 'composing-only') {
      const safari = reports.find((r) => r.profile === 'safari')!;
      expect(safari.verdict).toBe('SUBMIT_ON_IME_ENTER');
      expect(safari.submissions.map((s) => [s.value, s.phase])).toEqual([['안녕', 'ime-enter']]);
    }
    if (mode === 'fixed') {
      for (const r of reports) expect(r.submissions.map((s) => s.value)).toEqual(['안녕']);
    }
  });
}

test('safari 프로필 이벤트 순서: compositionend → keydown Enter 229 isComposing=false', async ({ open }) => {
  const page = await open('fixed');
  const [report] = await checkIme(page, { input: '#prompt', text: '안녕', profiles: ['safari'], recordEvents: true });
  const ime = report!.events!.filter((e: ImeEvent) => e.phase === 'ime-enter');
  const end = ime.findIndex((e) => e.type === 'compositionend');
  const keydown = ime.findIndex((e) => e.type === 'keydown' && e.key === 'Enter' && e.keyCode === 229 && e.isComposing === false);
  expect(end).toBeGreaterThanOrEqual(0);
  expect(keydown).toBeGreaterThan(end);
});

test('chromium 합성 프로필은 cdp 에서 관찰한 "입력창을 비우면 확정 문자열이 다시 들어감" 을 재현한다', async ({ open }) => {
  const page = await open('buggy');
  const [report] = await checkIme(page, { input: '#prompt', text: '안녕', profiles: ['chromium'] });
  expect(report!.submissions.map((s) => s.value)).toEqual(['안녕', '녕']);
  expect(report!.findings.map((f) => f.code)).toEqual(['SUBMIT_ON_IME_ENTER', 'TRAILING_CHAR']);
});

test('합성 드라이버는 React 식 값 추적기를 거치지 않고 값을 바꿔 onChange 가 나게 한다', async ({ page, server }) => {
  // React(inputValueTracking)는 요소의 value 세터를 덮어써 "마지막으로 코드가 넣은 값" 을 기억하고,
  // input 이벤트 때 실제 값과 다를 때만 onChange 를 부른다. el.value = v 로 바꾸면 추적기도 같이 바뀌어
  // onChange 가 안 난다 → imeplay 는 프로토타입의 네이티브 세터를 쓴다. 그 추적기를 그대로 흉내 내 확인한다.
  await page.goto(`${server.url}/chat.html?mode=fixed`);
  await page.evaluate(() => {
    const el = document.getElementById('prompt') as HTMLTextAreaElement & { __changes?: string[] };
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    let tracked = native.get!.call(el) as string;
    el.__changes = [];
    Object.defineProperty(el, 'value', {
      configurable: true,
      get: () => native.get!.call(el),
      set: (v: string) => {
        tracked = String(v);
        native.set!.call(el, v);
      },
    });
    el.addEventListener('input', () => {
      const actual = native.get!.call(el) as string;
      if (actual !== tracked) {
        tracked = actual;
        el.__changes!.push(actual); // React 라면 여기서 onChange
      }
    });
  });
  const session = await typeWithIme(page, '#prompt', '안녕', { profile: 'safari' });
  expect(session.composing).toBe('녕');
  const changes = await page.evaluate(() => (document.getElementById('prompt') as HTMLTextAreaElement & { __changes: string[] }).__changes);
  expect(changes).toEqual(['ㅇ', '아', '안', '안ㄴ', '안녀', '안녕']);
  await session.close();
});
