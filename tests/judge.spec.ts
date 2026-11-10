// AC-2: judge 가 "언제 무엇을 보냈나" 목록으로 판정을 정확히 가른다.
import { expect, test } from '@playwright/test';
import { judge, type Submission } from '../src/index.js';
import { extractValue, isSubmission, urlMatcher } from '../src/watch.js';

const at = (value: string, phase: Submission['phase']) => ({ value, phase });
const codes = (r: ReturnType<typeof judge>) => r.findings.map((f) => f.code);

test('진짜 Enter 에서 한 번, 정확한 값 → PASS', () => {
  const r = judge('안녕', [at('안녕', 'submit-enter')]);
  expect(r.verdict).toBe('PASS');
  expect(r.findings).toEqual([]);
});

test('확정용 Enter 에서 보내고 마지막 글자가 따로 감 → SUBMIT_ON_IME_ENTER + TRAILING_CHAR', () => {
  const r = judge('안녕', [at('안녕', 'ime-enter'), at('녕', 'submit-enter')]);
  expect(codes(r)).toEqual(['SUBMIT_ON_IME_ENTER', 'TRAILING_CHAR']);
  expect(r.verdict).toBe('SUBMIT_ON_IME_ENTER');
});

test('아무것도 안 보냄 → NO_SUBMIT', () => {
  const r = judge('안녕', []);
  expect(r.verdict).toBe('NO_SUBMIT');
  expect(codes(r)).toEqual(['NO_SUBMIT']);
});

test('같은 값 두 번 → DOUBLE_SUBMIT', () => {
  const r = judge('안녕', [at('안녕', 'submit-enter'), at('안녕', 'submit-enter')]);
  expect(r.verdict).toBe('DOUBLE_SUBMIT');
  expect(codes(r)).toEqual(['DOUBLE_SUBMIT']);
});

test('조합이 덜 된 값 → WRONG_VALUE', () => {
  const r = judge('안녕', [at('안', 'submit-enter')]);
  expect(r.verdict).toBe('WRONG_VALUE');
  expect(codes(r)).toEqual(['WRONG_VALUE']);
});

test('Safari 순서의 반쪽 수정: 확정용 Enter 에서 한 번만 감 → SUBMIT_ON_IME_ENTER 만', () => {
  const r = judge('안녕', [at('안녕', 'ime-enter')]);
  expect(codes(r)).toEqual(['SUBMIT_ON_IME_ENTER']);
});

test('전송 값 꺼내기: JSON 의 message·prompt, OpenAI 식 messages 마지막, 폼 인코딩, 그 밖엔 본문 그대로', () => {
  expect(extractValue(JSON.stringify({ message: '안녕' }))).toBe('안녕');
  expect(extractValue(JSON.stringify({ model: 'x', prompt: '안녕' }))).toBe('안녕');
  expect(
    extractValue(JSON.stringify({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: '안녕' }] })),
  ).toBe('안녕');
  expect(extractValue('q=%EC%95%88%EB%85%95&lang=ko')).toBe('안녕');
  expect(extractValue('안녕')).toBe('안녕');
  expect(extractValue(null)).toBe('');
});

test('URL 글롭: ** 는 아무 문자열, * 는 / 를 뺀 문자열; 전송은 GET 이 아닌 요청만', () => {
  const m = urlMatcher('**/api/chat')!;
  expect(m('http://127.0.0.1:3000/api/chat')).toBe(true);
  expect(m('http://127.0.0.1:3000/api/chat/stream')).toBe(false);
  expect(urlMatcher('**/api/*')!('https://x.dev/api/chat')).toBe(true);
  expect(urlMatcher(/\/v1\/chat/)!('https://x.dev/v1/chat/completions')).toBe(true);
  expect(isSubmission('GET', 'http://x/api/chat', m)).toBe(false);
  expect(isSubmission('POST', 'http://x/api/chat', m)).toBe(true);
  expect(isSubmission('POST', 'http://x/analytics', null)).toBe(true);
});
