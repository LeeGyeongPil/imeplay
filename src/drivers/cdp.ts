// cdp 드라이버: Chromium DevTools Protocol 로 "진짜" 조합 이벤트를 만든다(Chromium 전용).
//
//   compose → Input.imeSetComposition(text)     조합 문자열 갱신(compositionstart/update, input isComposing=true)
//   commit  → Input.insertText(text)            조합 확정(compositionend)
//   insert  → Input.insertText(text)            조합 없이 글자 삽입
//   확정용 Enter → dispatchKeyEvent rawKeyDown Enter, windowsVirtualKeyCode=229
//                → Input.insertText(조합 문자열) → keyUp Enter
//
// 주의: 조합 중에 Playwright 의 keyboard.press('Enter') 를 쓰면 keyCode 13 이 되고 조합 안에 '\n' 이
// 들어가 실제 IME 와 달라진다(조사 단계 프로브로 확인). 그래서 Enter keydown 을 CDP 로 직접 보낸다.
// Input.imeSetComposition·insertText 는 CDP 에서 experimental 표시된 명령이다.
import type { CDPSession, Page } from 'playwright';
import type { ImeStep } from '../steps.js';

export interface DriverSession {
  /** 아직 확정되지 않은 조합 문자열(없으면 null). */
  readonly composing: string | null;
  /** 단계 목록을 재생한다. */
  play(steps: readonly ImeStep[]): Promise<void>;
  /** 프로필 순서대로 "확정용 Enter" 를 재생한다. */
  pressEnterDuringComposition(): Promise<void>;
  /** 붙잡은 자원(CDP 세션 등)을 놓는다. 여러 번 불러도 된다. */
  close(): Promise<void>;
}

export async function createCdpSession(page: Page): Promise<DriverSession> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  let composing: string | null = null;
  let closed = false;

  return {
    get composing() {
      return composing;
    },

    async play(steps) {
      for (const step of steps) {
        if (step.type === 'compose') {
          // 커서를 조합 문자열 끝에 둔다(실제 IME 와 같은 위치).
          await cdp.send('Input.imeSetComposition', {
            text: step.text,
            selectionStart: step.text.length,
            selectionEnd: step.text.length,
          });
          composing = step.text;
        } else {
          // commit·insert 모두 insertText: 조합 중이면 확정(compositionend), 아니면 그냥 삽입.
          await cdp.send('Input.insertText', { text: step.text });
          composing = null;
        }
      }
    },

    async pressEnterDuringComposition() {
      const text = composing ?? '';
      // 1) 실제 IME 처럼 keyCode 229 로 Enter keydown — 앱에는 isComposing=true 로 보인다.
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 229,
        nativeVirtualKeyCode: 229,
      });
      // 2) IME 가 조합을 확정한다 → compositionend.
      //    앱이 1) 에서 입력창을 비웠다면 Chromium 은 확정 문자열을 새로 넣는다(마지막 글자 중복의 원인).
      await cdp.send('Input.insertText', { text });
      composing = null;
      // 3) Enter 를 뗀다.
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    },

    async close() {
      if (closed) return;
      closed = true;
      // 페이지가 이미 닫혔으면 detach 가 실패한다 — 정리 단계이므로 무시한다.
      await cdp.detach().catch(() => {});
    },
  };
}
