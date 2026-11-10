// synthetic 드라이버: page 안에서 CompositionEvent·KeyboardEvent·InputEvent 를 직접 dispatch 한다.
// 어느 브라우저(Chromium·Firefox·WebKit)에서나 돌고, "확정용 Enter" 순서를 프로필별로 바꿔 재생한다.
//
//   chromium  keydown Enter(229, isComposing=true) → (앱이 입력창을 비웠으면 확정 문자열 다시 삽입) → compositionend
//   firefox   keydown Enter(229, isComposing=true) → compositionend
//   safari    compositionend → keydown Enter(229, isComposing=false)
//
// 한계: 합성 이벤트는 isTrusted=false 다. 입력창 값은 브라우저가 바꿔 주지 않으므로 직접 바꾸는데,
// React 제어 컴포넌트도 onChange 가 나도록 HTMLTextAreaElement/HTMLInputElement 프로토타입의
// 네이티브 value 세터를 쓴다.
import type { Locator } from 'playwright';
import type { SyntheticProfile } from '../profiles.js';
import type { ImeStep } from '../steps.js';
import type { DriverSession } from './cdp.js';

type PageAction =
  | { action: 'play'; steps: readonly ImeStep[] }
  | { action: 'enter'; profile: SyntheticProfile };

/**
 * 브라우저 안에서 실행되는 함수(직렬화되어 넘어가므로 바깥 변수를 쓰지 않는다).
 * 조합 상태는 요소 객체에 `__imeplaySynthetic` 으로 붙여 두고 다음 호출에서 이어 쓴다.
 * 돌려주는 값: 남은 조합 문자열(없으면 null).
 */
function runInPage(el: Element, cmd: PageAction): string | null {
  if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) {
    throw new Error(`imeplay synthetic driver supports <textarea> and <input> only (got <${el.tagName.toLowerCase()}>)`);
  }
  const field = el;
  type State = { start: number; length: number; text: string } | null;
  const holder = field as unknown as { __imeplaySynthetic?: State };
  let comp: State = holder.__imeplaySynthetic ?? null;

  // 네이티브 세터로 값 바꾸기(React 가 값 변경을 알아채게)
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSet = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  const setValue = (value: string, caret: number) => {
    if (nativeSet) nativeSet.call(field, value);
    else field.value = value;
    try {
      field.setSelectionRange(caret, caret);
    } catch {
      // type=email 등 선택 범위를 지원하지 않는 input — 커서 이동만 건너뛴다.
    }
  };
  const caret = () => field.selectionStart ?? field.value.length;

  // keyCode 는 KeyboardEvent 생성자로 못 넣으므로 getter 로 덮는다.
  const key = (type: string, keyName: string, keyCode: number, isComposing: boolean) => {
    const ev = new KeyboardEvent(type, {
      key: keyName,
      code: keyName === 'Enter' ? 'Enter' : '',
      isComposing,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
    Object.defineProperty(ev, 'which', { get: () => keyCode });
    return field.dispatchEvent(ev);
  };
  const composition = (type: string, data: string) =>
    field.dispatchEvent(new CompositionEvent(type, { data, bubbles: true, cancelable: type === 'compositionstart', composed: true }));
  const input = (type: 'beforeinput' | 'input', data: string, inputType: string, isComposing: boolean) =>
    field.dispatchEvent(
      new InputEvent(type, { data, inputType, isComposing, bubbles: true, cancelable: type === 'beforeinput' && !isComposing, composed: true }),
    );

  // 조합 문자열을 text 로 바꾼다(조합 시작 위치 기준으로 그 구간만 교체).
  const updateComposition = (text: string) => {
    if (!comp) {
      const at = caret();
      composition('compositionstart', '');
      comp = { start: at, length: field.selectionEnd !== null ? field.selectionEnd - at : 0, text: '' };
    }
    composition('compositionupdate', text);
    input('beforeinput', text, 'insertCompositionText', true);
    const v = field.value;
    setValue(v.slice(0, comp.start) + text + v.slice(comp.start + comp.length), comp.start + text.length);
    comp = { start: comp.start, length: text.length, text };
    input('input', text, 'insertCompositionText', true);
  };

  if (cmd.action === 'play') {
    for (const step of cmd.steps) {
      if (step.type === 'compose') {
        key('keydown', 'Process', 229, comp !== null); // IME 가 처리하는 키는 key='Process', keyCode=229
        updateComposition(step.text);
        key('keyup', 'Process', 229, true);
      } else if (step.type === 'commit') {
        if (comp && comp.text !== step.text) updateComposition(step.text);
        composition('compositionend', step.text);
        comp = null;
      } else {
        // 조합 없는 삽입(공백·영문): beforeinput 이 취소되면 넣지 않는다.
        if (input('beforeinput', step.text, 'insertText', false)) {
          const at = caret();
          const end = field.selectionEnd ?? at;
          const v = field.value;
          setValue(v.slice(0, at) + step.text + v.slice(end), at + step.text.length);
          input('input', step.text, 'insertText', false);
        }
      }
    }
  } else {
    const text = comp?.text ?? '';
    const expected = field.value;
    if (cmd.profile === 'safari') {
      // Safari: 조합이 먼저 끝나고, 그 뒤에 Enter keydown 이 isComposing=false, keyCode 229 로 온다.
      composition('compositionend', text);
      comp = null;
      key('keydown', 'Enter', 229, false);
    } else {
      // Chromium·Firefox: 조합 중인 Enter keydown(isComposing=true, keyCode 229)이 먼저 온다.
      key('keydown', 'Enter', 229, true);
      if (cmd.profile === 'chromium' && field.value !== expected && text) {
        // 앱이 keydown 에서 입력창을 비웠다 → Chromium 은 조합 구간을 잃고 확정 문자열을 커서 위치에 새로 넣는다.
        // (cdp 프로필에서 실제로 관찰한 동작: '안녕' 전송 후 '녕' 이 다시 들어감)
        const at = caret();
        input('beforeinput', text, 'insertText', false);
        const v = field.value;
        setValue(v.slice(0, at) + text + v.slice(at), at + text.length);
        input('input', text, 'insertText', false);
      } else {
        composition('compositionend', text);
      }
      comp = null;
    }
    key('keyup', 'Enter', 13, false);
  }

  holder.__imeplaySynthetic = comp;
  return comp?.text ?? null;
}

export function createSyntheticSession(target: Locator, profile: SyntheticProfile): DriverSession {
  let composing: string | null = null;
  return {
    get composing() {
      return composing;
    },
    async play(steps) {
      composing = await target.evaluate(runInPage, { action: 'play', steps } as PageAction);
    },
    async pressEnterDuringComposition() {
      composing = await target.evaluate(runInPage, { action: 'enter', profile } as PageAction);
    },
    async close() {
      // 붙잡은 자원이 없다(상태는 페이지 안 요소에만 있다).
    },
  };
}
