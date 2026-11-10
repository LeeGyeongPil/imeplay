// 판정 규칙(순수 함수). 입력: 기대한 메시지와 "언제 무엇을 보냈나" 목록. 출력: 대표 판정 + 발견 목록.
//
//   PASS                 진짜 Enter 때 기대한 값을 딱 한 번 보냄
//   NO_SUBMIT            아무것도 안 보냄(Enter 가 전송을 못 함)
//   SUBMIT_ON_IME_ENTER  확정용 Enter(또는 그 전)에 보냄 — 사용자는 "조합 중에 메시지가 가 버려요" 를 겪는다
//   DOUBLE_SUBMIT        같은 메시지를 두 번 이상 보냄 — "메시지가 두 번 가요"
//   TRAILING_CHAR        기대값의 끝부분(마지막 글자)만 따로 보냄 — "마지막 글자가 따로 전송돼요"
//   WRONG_VALUE          그 밖의 다른 값(조합이 덜 된 '안', 빈 문자열 등)을 보냄

export type SubmitPhase = 'typing' | 'ime-enter' | 'submit-enter';

export interface Submission {
  /** 앱이 보낸 메시지(요청 본문에서 꺼낸 값). */
  value: string;
  /** 보낸 시점: 입력 중 / 확정용 Enter / 진짜 Enter. */
  phase: SubmitPhase;
  /** 요청 URL. */
  url: string;
  /** HTTP 메서드(WebSocket 은 'WS'). */
  method?: string;
  /** 어떤 통로로 보냈는지. */
  kind?: 'fetch' | 'xhr' | 'beacon' | 'websocket';
}

export type FindingCode = 'NO_SUBMIT' | 'SUBMIT_ON_IME_ENTER' | 'DOUBLE_SUBMIT' | 'TRAILING_CHAR' | 'WRONG_VALUE';
export type Verdict = 'PASS' | FindingCode;

export interface Finding {
  code: FindingCode;
  message: string;
}

export interface Judgement {
  /** 대표 판정: 문제가 없으면 PASS, 있으면 가장 중요한 발견 코드. */
  verdict: Verdict;
  /** 발견한 문제 전부(중요한 순서). 비어 있으면 PASS. */
  findings: Finding[];
}

// 대표 판정을 고르는 순서
const PRIORITY: FindingCode[] = ['NO_SUBMIT', 'SUBMIT_ON_IME_ENTER', 'DOUBLE_SUBMIT', 'TRAILING_CHAR', 'WRONG_VALUE'];

export function judge(expected: string, submissions: readonly Pick<Submission, 'value' | 'phase'>[]): Judgement {
  const findings: Finding[] = [];
  const add = (code: FindingCode, message: string) => {
    if (!findings.some((f) => f.code === code)) findings.push({ code, message });
  };

  if (submissions.length === 0) {
    add('NO_SUBMIT', 'nothing was sent after the real Enter');
    return { verdict: 'NO_SUBMIT', findings };
  }

  // 1) 진짜 Enter 보다 먼저 보낸 것
  const early = submissions.filter((s) => s.phase !== 'submit-enter');
  if (early.length > 0) {
    add('SUBMIT_ON_IME_ENTER', `sent during ${early[0]!.phase} (before the real Enter): ${show(early[0]!.value)}`);
  }

  // 2) 같은 값 두 번 이상
  const exact = submissions.filter((s) => s.value === expected);
  if (exact.length >= 2) add('DOUBLE_SUBMIT', `${show(expected)} was sent ${exact.length} times`);

  // 3) 기대값과 다른 값: 끝부분만 따로 갔으면 TRAILING_CHAR, 아니면 WRONG_VALUE
  for (const s of submissions) {
    if (s.value === expected) continue;
    const isTail = s.value !== '' && expected.endsWith(s.value) && submissions.length > 1;
    if (isTail) add('TRAILING_CHAR', `the tail ${show(s.value)} of ${show(expected)} was sent separately`);
    else add('WRONG_VALUE', `sent ${show(s.value)} instead of ${show(expected)}`);
  }

  findings.sort((a, b) => PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code));
  return { verdict: findings[0]?.code ?? 'PASS', findings };
}

const show = (v: string) => `'${v}'`;

/** 전송 목록을 한 줄로: ['안녕'@ime-enter, '녕'@submit-enter] */
export function formatSubmissions(submissions: readonly Pick<Submission, 'value' | 'phase'>[]): string {
  return `[${submissions.map((s) => `${show(s.value)}@${s.phase}`).join(', ')}]`;
}
