// 한글 문장을 두벌식 자판으로 칠 때 IME 가 보여 주는 조합 단계로 바꾼다.
//
// 방법: 문장을 "누르는 자판 순서"(자모 열)로 풀고, 두벌식 오토마타에 한 자모씩 넣으면서
// 화면에 보이는 조합 문자열을 기록한다. 예) '안녕' → ㅇ ㅏ ㄴ ㄴ ㅕ ㅇ
//   ㅇ → [ㅇ]   ㅏ → [아]   ㄴ → [안]   ㄴ → 안 확정, [ㄴ]   ㅕ → [녀]   ㅇ → [녕]
// 마지막 음절은 확정하지 않고 조합 중으로 남긴다(그 상태에서 Enter 를 누르는 것이 시험 대상).
import type { ImeStep } from './steps.js';

// 유니코드 한글 음절 = 0xAC00 + (초성 × 21 + 중성) × 28 + 종성
const SYLLABLE_BASE = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'; // 초성 19
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'; // 중성 21
const JONG = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ']; // 종성 28(0 = 없음)

// 두 번 눌러 만드는 겹모음·겹받침(두벌식)
const DOUBLE_VOWEL: Record<string, string> = {
  ㅗㅏ: 'ㅘ', ㅗㅐ: 'ㅙ', ㅗㅣ: 'ㅚ', ㅜㅓ: 'ㅝ', ㅜㅔ: 'ㅞ', ㅜㅣ: 'ㅟ', ㅡㅣ: 'ㅢ',
};
const DOUBLE_JONG: Record<string, string> = {
  ㄱㅅ: 'ㄳ', ㄴㅈ: 'ㄵ', ㄴㅎ: 'ㄶ', ㄹㄱ: 'ㄺ', ㄹㅁ: 'ㄻ', ㄹㅂ: 'ㄼ',
  ㄹㅅ: 'ㄽ', ㄹㅌ: 'ㄾ', ㄹㅍ: 'ㄿ', ㄹㅎ: 'ㅀ', ㅂㅅ: 'ㅄ',
};
// 거꾸로: 겹모음·겹받침 → 두 자모
const SPLIT_VOWEL = Object.fromEntries(Object.entries(DOUBLE_VOWEL).map(([k, v]) => [v, k]));
const SPLIT_JONG = Object.fromEntries(Object.entries(DOUBLE_JONG).map(([k, v]) => [v, k]));

const isConsonant = (ch: string) => CHO.includes(ch) || JONG.includes(ch);
const isVowel = (ch: string) => JUNG.includes(ch);
const isSyllable = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0;
  return code >= SYLLABLE_BASE && code <= SYLLABLE_LAST;
};

/** 음절 하나를 누르는 자모 순서로 푼다. 예) '앉' → ㅇ ㅏ ㄴ ㅈ, '와' → ㅇ ㅗ ㅏ */
function syllableToKeys(ch: string): string[] {
  const index = (ch.codePointAt(0) ?? 0) - SYLLABLE_BASE;
  const cho = CHO[Math.floor(index / (21 * 28))] ?? '';
  const jung = JUNG[Math.floor((index % (21 * 28)) / 28)] ?? '';
  const jong = JONG[index % 28] ?? '';
  const keys = [cho, ...(SPLIT_VOWEL[jung] ?? jung)];
  if (jong) keys.push(...(SPLIT_JONG[jong] ?? jong));
  return keys;
}

/** 초·중·종성(호환 자모)으로 화면에 보일 글자를 만든다. 초성만·중성만이면 자모 그대로. */
function compose(cho: string, jung: string, jong: string): string {
  if (cho && jung) {
    const code = SYLLABLE_BASE + (CHO.indexOf(cho) * 21 + JUNG.indexOf(jung)) * 28 + JONG.indexOf(jong);
    return String.fromCodePoint(code);
  }
  return cho || jung;
}

/**
 * 한글 문장 → IME 조합 단계 목록(두벌식).
 *
 * - 받침 넘어가기: '아니' → … compose 안, commit 아, compose 니
 * - 받침 + 자음: '안녕' → … compose 안, commit 안, compose ㄴ
 * - 겹모음·겹받침: '와' → ㅇ, 오, 와 / '앉' → ㅇ, 아, 안, 앉
 * - 한글이 아닌 글자(공백·영문·문장부호)는 조합을 확정한 뒤 `insert` 로 그대로 넣는다.
 */
export function koreanSteps(text: string): ImeStep[] {
  const steps: ImeStep[] = [];
  // 지금 조합 중인 음절(호환 자모). 모두 빈 문자열이면 조합 없음.
  let cho = '';
  let jung = '';
  let jong = '';

  const current = () => compose(cho, jung, jong);
  const commit = (text = current()) => {
    if (text) steps.push({ type: 'commit', text });
    cho = jung = jong = '';
  };
  const show = () => steps.push({ type: 'compose', text: current() });

  // 자모 하나를 눌렀을 때 두벌식 IME 가 하는 일
  const press = (key: string) => {
    if (isVowel(key)) {
      if (jong) {
        // 받침 넘어가기: 받침(겹받침이면 뒤쪽 자음)이 새 음절의 초성이 된다.
        const pair = SPLIT_JONG[jong];
        const keep = pair ? pair[0]! : '';
        const move = pair ? pair[1]! : jong;
        commit(compose(cho, jung, keep));
        cho = move;
        jung = key;
      } else if (jung && DOUBLE_VOWEL[jung + key]) {
        jung = DOUBLE_VOWEL[jung + key]!; // 오 + ㅏ → 와
      } else if (jung) {
        commit();
        jung = key; // 모음만 따로(예: 'ㅏ' 단독)
      } else {
        jung = key; // ㅇ + ㅏ → 아
      }
    } else {
      if (cho && jung && !jong && JONG.includes(key)) {
        jong = key; // 아 + ㄴ → 안
      } else if (jong && DOUBLE_JONG[jong + key]) {
        jong = DOUBLE_JONG[jong + key]!; // 안 + ㅈ → 앉
      } else {
        commit(); // 안 + ㄴ → 안 확정, ㄴ 조합
        cho = key;
      }
    }
    show();
  };

  // 낱자모('ㅋㅋ' 등)는 앞뒤 음절과 합쳐지지 않게 따로 조합한다(다음 글자 전에 확정).
  let isolated = false;
  for (const ch of text) {
    if (isolated) commit();
    isolated = false;
    if (isSyllable(ch)) {
      for (const key of syllableToKeys(ch)) press(key);
    } else if (isConsonant(ch) || isVowel(ch)) {
      commit();
      press(ch);
      isolated = true;
    } else {
      commit();
      steps.push({ type: 'insert', text: ch });
    }
  }
  return steps;
}
