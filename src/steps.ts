// IME 입력을 "단계" 목록으로 표현한다. 드라이버(cdp·synthetic)는 이 목록을 위에서부터 그대로 재생한다.
import { ImeplayError } from './errors.js';

/**
 * IME 입력 한 단계.
 * - `compose`: 조합 중인 문자열을 바꾼다(예: 'ㅇ' → '아' → '안'). 조합이 없으면 새로 시작한다.
 * - `commit`: 지금 조합을 `text` 로 확정한다(compositionend). 조합 중이 아닐 때는 쓸 수 없다.
 * - `insert`: 조합 없이 글자를 그대로 넣는다(공백·영문·문장부호). 조합 중일 때는 먼저 commit 해야 한다.
 */
export type ImeStep =
  | { type: 'compose'; text: string }
  | { type: 'commit'; text: string }
  | { type: 'insert'; text: string };

/**
 * 단계 목록이 재생 가능한지 확인하고, 마지막에 남는 조합 문자열을 돌려준다.
 * 조합으로 끝나지 않으면(마지막 글자가 이미 확정됨) `composing` 은 null 이다.
 */
export function validateSteps(steps: readonly ImeStep[]): { composing: string | null; finalText: string } {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ImeplayError('steps must be a non-empty array of {type, text}');
  }
  let committed = '';
  let composing: string | null = null;
  for (const [i, step] of steps.entries()) {
    const where = `steps[${i}]`;
    if (step === null || typeof step !== 'object' || typeof step.text !== 'string') {
      throw new ImeplayError(`${where} must be an object with a string 'text'`);
    }
    switch (step.type) {
      case 'compose':
        if (step.text === '') throw new ImeplayError(`${where}: compose text must not be empty`);
        composing = step.text;
        break;
      case 'commit':
        if (composing === null) throw new ImeplayError(`${where}: commit without an active composition`);
        committed += step.text;
        composing = null;
        break;
      case 'insert':
        if (step.text === '') throw new ImeplayError(`${where}: insert text must not be empty`);
        if (composing !== null) {
          throw new ImeplayError(`${where}: insert while composing — add a {type:'commit'} step first`);
        }
        committed += step.text;
        break;
      default:
        throw new ImeplayError(`${where}: unknown step type '${String((step as { type: unknown }).type)}'`);
    }
  }
  return { composing, finalText: committed + (composing ?? '') };
}
