// AC-3·AC-5: Chromium 의 실제 조합 이벤트(cdp 프로필)로 픽스처 3종을 시험한다.
import { checkIme, type ImeEvent } from '../src/index.js';
import { expect, test } from './helpers/server.js';

test.skip(({ browserName }) => browserName !== 'chromium', 'cdp profile is Chromium-only');

const values = (r: { submissions: { value: string }[] }) => r.submissions.map((s) => s.value);
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

/** 확정용 Enter 단계의 이벤트 순서: keydown Enter 229 isComposing=true 가 compositionend 보다 먼저인가 */
function enterBeforeCompositionEnd(events: ImeEvent[]) {
  const ime = events.filter((e) => e.phase === 'ime-enter');
  const keydown = ime.findIndex((e) => e.type === 'keydown' && e.key === 'Enter' && e.keyCode === 229 && e.isComposing === true);
  const end = ime.findIndex((e) => e.type === 'compositionend');
  return { keydown, end };
}

test('buggy: 마지막 글자 중복이 그대로 재현된다 (안녕 → 안녕, 녕)', async ({ open, server }) => {
  const page = await open('buggy');
  const before = server.posts.length; // 서버는 워커 안 테스트들이 같이 쓴다 — 이 테스트에서 늘어난 만큼만 본다
  const [report] = await checkIme(page, { input: '#prompt', text: '안녕', profiles: ['cdp'], recordEvents: true });
  expect(values(report!)).toEqual(['안녕', '녕']);
  expect(report!.submissions.map((s) => s.phase)).toEqual(['ime-enter', 'submit-enter']);
  expect(report!.verdict).not.toBe('PASS');
  expect(codes(report!)).toEqual(['SUBMIT_ON_IME_ENTER', 'TRAILING_CHAR']);
  // 확정용 Enter 는 실제 IME 처럼 keyCode 229, isComposing=true 로 보였다
  expect(enterBeforeCompositionEnd(report!.events!).keydown).toBeGreaterThanOrEqual(0);
  // 기본 모드는 요청을 가로채므로 로컬 서버까지 간 POST 는 없다
  expect(server.posts.slice(before)).toEqual([]);
});

for (const mode of ['composing-only', 'fixed'] as const) {
  test(`${mode}: 진짜 Enter 에서 한 번만 전송 → PASS, 이벤트 순서는 keydown 229 → compositionend`, async ({ open, server }) => {
    const page = await open(mode);
    const before = server.posts.length;
    const [report] = await checkIme(page, { input: '#prompt', text: '안녕', profiles: ['cdp'], recordEvents: true });
    expect(report!.verdict).toBe('PASS');
    expect(values(report!)).toEqual(['안녕']);
    expect(report!.submissions[0]!.phase).toBe('submit-enter');
    const { keydown, end } = enterBeforeCompositionEnd(report!.events!);
    expect(keydown).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(keydown);
    expect(server.posts.slice(before)).toEqual([]);
  });
}

test('passthrough: 가로채지 않으면 로컬 서버가 POST 를 실제로 받는다', async ({ open, server }) => {
  const page = await open('fixed');
  const before = server.posts.length;
  const [report] = await checkIme(page, { input: '#prompt', text: '안녕', profiles: ['cdp'], passthrough: true, request: '**/api/chat' });
  expect(report!.verdict).toBe('PASS');
  expect(server.posts.slice(before)).toEqual(['안녕']);
});

test('long sentence: 안녕하세요 반가워요 를 fixed 에 넣으면 한 번, 값 그대로 / buggy 는 FAIL', async ({ open }) => {
  const text = '안녕하세요 반가워요';
  const fixed = await open('fixed');
  const [ok] = await checkIme(fixed, { input: '#prompt', text, profiles: ['cdp'] });
  expect(ok!.verdict).toBe('PASS');
  expect(values(ok!)).toEqual([text]); // 자모 찌꺼기·공백 누락 없음

  const buggy = await open('buggy');
  const [bad] = await checkIme(buggy, { input: '#prompt', text, profiles: ['cdp'] });
  expect(bad!.verdict).not.toBe('PASS');
  expect(values(bad!)).toEqual([text, '요']);
});
