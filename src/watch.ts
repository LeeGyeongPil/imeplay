// 전송 감시: "앱이 언제, 무엇을 보냈나" 를 페이지 안에서 동기적으로 기록한다.
//
// 1) init script 가 fetch·XMLHttpRequest.send·navigator.sendBeacon·WebSocket.send 를 감싼다.
//    호출되는 바로 그 순간 window.__imeplay.phase(typing / ime-enter / submit-enter)를 같이 적으므로
//    시간 대기 없이 "확정용 Enter 때 보냈는지, 진짜 Enter 때 보냈는지" 가 결정적으로 갈린다.
// 2) 같은 조건의 요청을 page.route 로 가로채 가짜 200 을 돌려준다 → 실제 LLM 호출·과금이 없다.
//    (passthrough: true 면 가로채지 않는다)
import type { Page, Route } from 'playwright';

export type Phase = 'load' | 'typing' | 'ime-enter' | 'submit-enter' | 'done';

/** 페이지 안에서 적은 원본 기록. */
export interface RawRecord {
  kind: 'fetch' | 'xhr' | 'beacon' | 'websocket';
  method: string;
  url: string;
  body: string | null;
  phase: Phase;
}

/** 페이지 안에서 적은 키보드·조합·입력 이벤트. */
export interface ImeEvent {
  type: string;
  key: string | null;
  keyCode: number | null;
  isComposing: boolean | null;
  data: string | null;
  inputType: string | null;
  phase: Phase;
}

export interface WatchConfig {
  request?: string | RegExp;
  passthrough?: boolean;
}

// 기록 개수 상한(무한히 쌓이지 않게)
const MAX_RECORDS = 1000;
const MAX_EVENTS = 2000;

/** init script 본문 — 페이지의 다른 스크립트보다 먼저 실행된다. 바깥 변수를 쓰지 않는다. */
function watchScript(limits: { maxRecords: number; maxEvents: number }) {
  const w = window as unknown as { __imeplay?: unknown };
  if (w.__imeplay) return;
  const state = { phase: 'load' as string, records: [] as unknown[], events: [] as unknown[] };
  Object.defineProperty(window, '__imeplay', { value: state, enumerable: false });

  const push = (rec: Record<string, unknown>) => {
    if (state.records.length < limits.maxRecords) state.records.push(rec);
  };
  const absolute = (u: unknown) => {
    try {
      return new URL(String(u), location.href).href;
    } catch {
      return String(u);
    }
  };
  const bodyText = (b: unknown): string | null => {
    if (b === undefined || b === null) return null;
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (typeof FormData !== 'undefined' && b instanceof FormData) {
      const o: Record<string, string> = {};
      b.forEach((v, k) => (o[k] = typeof v === 'string' ? v : '[file]'));
      return JSON.stringify(o);
    }
    return '[binary]';
  };

  // fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      try {
        const isRequest = typeof Request !== 'undefined' && input instanceof Request;
        const method = String(init?.method ?? (isRequest ? (input as Request).method : 'GET')).toUpperCase();
        const rec = {
          kind: 'fetch',
          method,
          url: absolute(isRequest ? (input as Request).url : input),
          body: init && init.body !== undefined ? bodyText(init.body) : null,
          phase: state.phase,
        };
        push(rec);
        // Request 객체에 담긴 본문은 비동기로만 읽힌다 — 기록은 먼저 남기고 본문은 나중에 채운다.
        if (rec.body === null && isRequest && method !== 'GET' && method !== 'HEAD') {
          (input as Request).clone().text().then((t) => (rec.body = t), () => {});
        }
      } catch {
        // 감시 실패가 앱 동작을 바꾸면 안 된다.
      }
      return origFetch.call(window, input, init);
    } as typeof window.fetch;
  }

  // XMLHttpRequest
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const opened = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      opened.set(this, { method: String(method).toUpperCase(), url: absolute(url) });
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const o = opened.get(this);
        push({ kind: 'xhr', method: o?.method ?? 'GET', url: o?.url ?? '', body: bodyText(body), phase: state.phase });
      } catch {
        // 무시
      }
      return origSend.call(this, body);
    };
  }

  // navigator.sendBeacon
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      push({ kind: 'beacon', method: 'POST', url: absolute(url), body: bodyText(data), phase: state.phase });
      return origBeacon(url, data);
    };
  }

  // WebSocket.send
  if (window.WebSocket) {
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      push({ kind: 'websocket', method: 'WS', url: this.url, body: bodyText(data), phase: state.phase });
      return origWsSend.call(this, data as string);
    };
  }

  // 키보드·조합·입력 이벤트 기록(캡처 단계 — 앱 핸들러보다 먼저 본다)
  for (const type of ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    document.addEventListener(
      type,
      (e: Event) => {
        if (state.phase === 'load' || state.events.length >= limits.maxEvents) return;
        const k = e as KeyboardEvent & CompositionEvent & InputEvent;
        state.events.push({
          type: e.type,
          key: typeof k.key === 'string' ? k.key : null,
          keyCode: typeof k.keyCode === 'number' ? k.keyCode : null,
          isComposing: typeof k.isComposing === 'boolean' ? k.isComposing : null,
          data: typeof k.data === 'string' ? k.data : null,
          inputType: typeof k.inputType === 'string' ? k.inputType : null,
          phase: state.phase,
        });
      },
      true,
    );
  }
}

/** 글롭('**' = 아무 문자열, '*' = '/' 를 뺀 아무 문자열)이나 RegExp 로 URL 판별 함수를 만든다. */
export function urlMatcher(pattern: string | RegExp | undefined): ((url: string) => boolean) | null {
  if (pattern === undefined) return null;
  if (pattern instanceof RegExp) return (url) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(url);
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i++;
    } else if (ch === '*') {
      source += '[^/]*';
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${source}$`);
  return (url) => re.test(url);
}

/** 이 요청을 "전송" 으로 볼지: GET·HEAD 가 아니고, 패턴이 있으면 URL 이 맞을 때. */
export function isSubmission(method: string, url: string, matcher: ((url: string) => boolean) | null): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  return matcher ? matcher(url) : true;
}

/** 요청 본문에서 사용자가 입력한 메시지를 꺼낸다(JSON 의 message·prompt·content… 또는 본문 그대로). */
export function extractValue(body: string | null): string {
  if (body === null) return '';
  const KEYS = ['message', 'prompt', 'content', 'text', 'input', 'query', 'q'];
  const fromObject = (o: unknown, depth: number): string | null => {
    if (typeof o === 'string') return o;
    if (!o || typeof o !== 'object' || depth > 3) return null;
    const obj = o as Record<string, unknown>;
    for (const k of KEYS) {
      const v = obj[k];
      if (typeof v === 'string') return v;
    }
    // OpenAI 류: { messages: [..., { role: 'user', content }] } → 마지막 메시지
    if (Array.isArray(obj.messages) && obj.messages.length > 0) {
      const last = fromObject(obj.messages[obj.messages.length - 1], depth + 1);
      if (last !== null) return last;
    }
    for (const k of KEYS) {
      const nested = fromObject(obj[k], depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  };
  try {
    const found = fromObject(JSON.parse(body), 0);
    if (found !== null) return found;
  } catch {
    // JSON 이 아니면 아래로
  }
  if (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(body)) {
    const params = new URLSearchParams(body);
    for (const k of KEYS) {
      const v = params.get(k);
      if (v !== null) return v;
    }
  }
  return body;
}

export interface WatchHandle {
  /** init script 와 route 스텁을 페이지에서 걷어 낸다(checkIme 가 끝날 때 부른다). */
  dispose(): Promise<void>;
}

/**
 * 페이지에 init script(전송·이벤트 기록)와 route 스텁(가짜 200)을 설치한다. 다음 로드부터 동작한다.
 * 돌려받은 handle.dispose() 로 둘 다 걷어 내므로, checkIme 가 끝난 뒤 사용자 테스트의 요청은 가로채지 않는다.
 */
export async function installWatch(page: Page, config: WatchConfig): Promise<WatchHandle> {
  const disposables: { dispose(): Promise<void> }[] = [];
  disposables.push(await page.addInitScript(watchScript, { maxRecords: MAX_RECORDS, maxEvents: MAX_EVENTS }));
  if (!config.passthrough) {
    const matcher = urlMatcher(config.request);
    const stub = async (route: Route) => {
      const req = route.request();
      try {
        if (req.resourceType() !== 'document' && isSubmission(req.method(), req.url(), matcher)) {
          // 가짜 응답: 받은 메시지를 되돌려 주는 연습용 목 응답
          const value = extractValue(req.postData());
          await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ reply: `(mock) 받았습니다: ${value}`, imeplay: 'stub' }),
          });
        } else {
          await route.fallback();
        }
      } catch {
        // 페이지가 이미 닫히는 중이면 응답할 곳이 없다 — 무시한다.
      }
    };
    disposables.push(await page.route('**/*', stub));
  }
  return {
    async dispose() {
      for (const d of disposables.splice(0)) await d.dispose().catch(() => {});
    },
  };
}

/** 지금 단계를 페이지에 표시한다(다음 기록부터 이 단계로 적힌다). */
export async function setPhase(page: Page, phase: Phase): Promise<void> {
  await page.evaluate((p) => {
    const s = (window as unknown as { __imeplay?: { phase: string } }).__imeplay;
    if (s) s.phase = p;
  }, phase);
}

/** 앱이 다음 프레임에 보내는 경우까지 한 번 정리한다: 이중 requestAnimationFrame + 0ms 타이머(최대 200ms). */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const done = () => setTimeout(resolve, 0);
        const fallback = setTimeout(resolve, 200); // 숨은 탭 등에서 rAF 가 멈춰도 끝나게
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(fallback);
            done();
          }),
        );
      }),
  );
}

export interface WatchSnapshot {
  installed: boolean;
  records: RawRecord[];
  events: ImeEvent[];
}

/** 페이지 안 기록을 읽어 온다. */
export async function readWatch(page: Page): Promise<WatchSnapshot> {
  return page.evaluate(() => {
    const s = (window as unknown as { __imeplay?: { records: unknown[]; events: unknown[] } }).__imeplay;
    if (!s) return { installed: false, records: [], events: [] };
    return { installed: true, records: s.records as RawRecord[], events: s.events as ImeEvent[] };
  });
}
