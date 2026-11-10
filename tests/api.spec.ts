// AC-6·AC-9(일부): 공개 API — 단언, 프로필 고르기, 예외, 실행 옵션.
import {
  checkIme,
  expectSingleSubmit,
  ImeAssertionError,
  ImeplayError,
  resolveLaunchOptions,
  resolveProfiles,
  typeWithIme,
  UnsupportedProfileError,
} from '../src/index.js';
import { expect, test } from './helpers/server.js';

test('expectSingleSubmit: buggy 는 ImeAssertionError(프로필·판정·전송 목록), fixed 는 통과', async ({ open, browserName }) => {
  const buggy = await open('buggy');
  const bad = await checkIme(buggy, { input: '#prompt', text: '안녕', profiles: 'auto', request: '**/api/chat' });
  let error: unknown;
  try {
    expectSingleSubmit(bad);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ImeAssertionError);
  expect(error).toBeInstanceOf(ImeplayError);
  const message = (error as Error).message;
  const firstProfile = resolveProfiles(browserName, 'auto')[0]!;
  expect(message).toContain(`${firstProfile}: SUBMIT_ON_IME_ENTER`);
  expect(message).toContain("'안녕'@ime-enter");

  const fixed = await open('fixed');
  const good = await checkIme(fixed, { input: '#prompt', text: '안녕', profiles: 'auto', request: '**/api/chat' });
  expect(() => expectSingleSubmit(good)).not.toThrow();
  expect(good.map((r) => r.profile)).toEqual(resolveProfiles(browserName, 'auto'));
});

test('expectSingleSubmit: 리포트가 비어 있으면 실패로 본다', () => {
  expect(() => expectSingleSubmit([])).toThrow(ImeAssertionError);
});

test('resolveProfiles: auto 는 브라우저마다 다르다', () => {
  expect(resolveProfiles('chromium', 'auto')).toEqual(['cdp', 'chromium', 'firefox', 'safari']);
  expect(resolveProfiles('firefox', 'auto')).toEqual(['firefox']);
  expect(resolveProfiles('webkit', 'auto')).toEqual(['safari']);
  expect(resolveProfiles('webkit', ['safari', 'chromium'])).toEqual(['safari', 'chromium']);
});

test('Chromium 이 아닌 브라우저에서 cdp 를 요청하면 UnsupportedProfileError', () => {
  expect(() => resolveProfiles('firefox', ['cdp'])).toThrow(UnsupportedProfileError);
  expect(() => resolveProfiles('webkit', ['safari', 'cdp'])).toThrow(UnsupportedProfileError);
  expect(() => resolveProfiles('chromium', ['nope' as never])).toThrow(ImeplayError);
});

test('실제 Firefox·WebKit 페이지에서 cdp 를 요청하면 UnsupportedProfileError', async ({ open, browserName }) => {
  test.skip(browserName === 'chromium', 'cdp works on Chromium');
  const page = await open('fixed');
  await expect(typeWithIme(page, '#prompt', '안녕', { profile: 'cdp' })).rejects.toBeInstanceOf(UnsupportedProfileError);
});

test('checkIme 입력 검사: 조합으로 끝나지 않는 문장·page.goto 전 페이지는 ImeplayError', async ({ page, open }) => {
  await expect(checkIme(page, { input: '#prompt', text: '안녕' })).rejects.toThrow(/page.goto/);
  const fixed = await open('fixed');
  await expect(checkIme(fixed, { input: '#prompt', text: 'hello' })).rejects.toThrow(/does not end while composing/);
});

test('launch options: IMEPLAY_CHROMIUM_ARGS 를 공백으로 나눠 args 로, 없으면 비움', () => {
  expect(resolveLaunchOptions({ IMEPLAY_CHROMIUM_ARGS: '--single-process --no-zygote' }).args).toEqual([
    '--single-process',
    '--no-zygote',
  ]);
  expect(resolveLaunchOptions({}).args).toEqual([]);
  expect(resolveLaunchOptions({ IMEPLAY_CHROMIUM_ARGS: '  ' }).args).toEqual([]);
  expect(resolveLaunchOptions({}, ['--lang=ko']).args).toEqual(['--lang=ko']);
});

test('checkIme 가 끝나면 가짜 응답(route)을 걷어 내 이후 요청은 실제 서버로 간다', async ({ open, server }) => {
  const page = await open('fixed');
  await checkIme(page, { input: '#prompt', text: '안녕', profiles: ['safari'] });
  const before = server.posts.length;
  const reply = await page.evaluate(async () => {
    const res = await fetch('/api/chat', { method: 'POST', body: JSON.stringify({ message: 'after-check' }) });
    return (await res.json()).imeplay as string;
  });
  expect(reply).toBe('fixture-server');
  expect(server.posts.slice(before)).toEqual(['after-check']);
});

test('일본어처럼 단계를 직접 줘도 같은 방식으로 판정한다', async ({ open }) => {
  const page = await open('composing-only');
  const steps = [
    { type: 'compose' as const, text: 'に' },
    { type: 'compose' as const, text: 'にほ' },
    { type: 'compose' as const, text: 'にほん' },
    { type: 'compose' as const, text: '日本' },
  ];
  const reports = await checkIme(page, { input: '#prompt', steps, profiles: ['safari', 'firefox'] });
  expect(reports.map((r) => [r.profile, r.verdict])).toEqual([
    ['safari', 'SUBMIT_ON_IME_ENTER'],
    ['firefox', 'PASS'],
  ]);
});
