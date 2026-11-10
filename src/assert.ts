// 테스트용 단언: 모든 프로필이 PASS 여야 한다. 하나라도 아니면 무엇이 언제 전송됐는지 담아 던진다.
import type { ImeReport } from './check.js';
import { ImeAssertionError } from './errors.js';
import { formatSubmissions } from './judge.js';

/** 리포트 한 줄: `safari: SUBMIT_ON_IME_ENTER — sent ['안녕'@ime-enter]` */
export function describeReport(report: ImeReport): string {
  const codes = report.findings.map((f) => f.code).join('+') || 'PASS';
  return `${report.profile}: ${codes} — sent ${formatSubmissions(report.submissions)}`;
}

/**
 * checkIme 결과가 "진짜 Enter 에서 한 번만, 정확한 값으로 전송" 인지 확인한다.
 * 하나라도 실패하면 ImeAssertionError (메시지에 프로필·판정·전송 목록).
 */
export function expectSingleSubmit(reports: ImeReport | readonly ImeReport[]): void {
  const list: readonly ImeReport[] = Array.isArray(reports) ? reports : [reports as ImeReport];
  if (list.length === 0) throw new ImeAssertionError('imeplay: no reports to check (did checkIme run any profile?)');
  const failed = list.filter((r) => r.verdict !== 'PASS');
  if (failed.length === 0) return;
  const text = failed[0]!.text;
  const lines = failed.map((r) => `  ${describeReport(r)}`);
  throw new ImeAssertionError(
    `imeplay: ${failed.length} of ${list.length} IME profile(s) failed for ${JSON.stringify(text)}\n` +
      `${lines.join('\n')}\n` +
      `  hint: ignore Enter while composing — if (e.isComposing || e.keyCode === 229) return;`,
  );
}
