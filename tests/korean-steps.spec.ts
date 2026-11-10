// AC-1: koreanSteps 가 두벌식 IME 의 조합 단계를 그대로 만든다.
import { expect, test } from '@playwright/test';
import { koreanSteps, validateSteps, type ImeStep } from '../src/index.js';

// 'compose ㅇ' / 'commit 안' / 'insert  ' 처럼 짧게 써서 비교한다.
const short = (steps: ImeStep[]) => steps.map((s) => `${s.type} ${s.text}`);

test('안녕: 받침 + 자음이면 앞 음절을 확정하고 새로 조합한다', () => {
  expect(short(koreanSteps('안녕'))).toEqual([
    'compose ㅇ',
    'compose 아',
    'compose 안',
    'commit 안',
    'compose ㄴ',
    'compose 녀',
    'compose 녕',
  ]);
});

test('아니: 받침이 다음 음절 초성으로 넘어간다', () => {
  expect(short(koreanSteps('아니'))).toEqual(['compose ㅇ', 'compose 아', 'compose 안', 'commit 아', 'compose 니']);
});

test('와: 겹모음(ㅗ + ㅏ)', () => {
  expect(short(koreanSteps('와'))).toEqual(['compose ㅇ', 'compose 오', 'compose 와']);
});

test('앉: 겹받침(ㄴ + ㅈ)', () => {
  expect(short(koreanSteps('앉'))).toEqual(['compose ㅇ', 'compose 아', 'compose 안', 'compose 앉']);
});

test('안자: 겹받침이 생겼다가 모음이 오면 뒤 자음만 넘어간다', () => {
  expect(short(koreanSteps('안자'))).toEqual([
    'compose ㅇ',
    'compose 아',
    'compose 안',
    'compose 앉',
    'commit 안',
    'compose 자',
  ]);
});

test('안 a: 공백·영문은 조합을 확정한 뒤 insert', () => {
  expect(short(koreanSteps('안 a'))).toEqual(['compose ㅇ', 'compose 아', 'compose 안', 'commit 안', 'insert  ', 'insert a']);
});

test('긴 문장도 단계를 재생하면 원문 그대로가 되고, 마지막 음절은 조합 중으로 남는다', () => {
  for (const text of ['안녕하세요 반가워요', '닭이 앉았어요', '꽃밭에서 뛰어놀자', 'ㅋㅋ 좋아']) {
    const { finalText, composing } = validateSteps(koreanSteps(text));
    expect(finalText, text).toBe(text);
    expect(composing, text).toBe([...text].at(-1));
  }
});

test('validateSteps 는 잘못된 단계 목록을 거부한다', () => {
  expect(() => validateSteps([])).toThrow(/non-empty/);
  expect(() => validateSteps([{ type: 'commit', text: '안' }])).toThrow(/without an active composition/);
  expect(() => validateSteps([{ type: 'compose', text: 'か' }, { type: 'insert', text: 'a' }])).toThrow(/commit/);
  // 일본어처럼 직접 준 단계: 마지막 compose 가 조합 중으로 남는다
  expect(validateSteps([{ type: 'compose', text: 'に' }, { type: 'compose', text: 'にほ' }, { type: 'compose', text: '日本' }])).toEqual({
    composing: '日本',
    finalText: '日本',
  });
});
