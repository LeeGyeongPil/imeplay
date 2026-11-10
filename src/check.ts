// checkIme: 프로필마다 페이지를 새로 열고 → 한글을 조합 입력 → 확정용 Enter → 진짜 Enter → 판정.
// typeWithIme: 그중 "조합 입력" 부분만 따로 쓰고 싶을 때.
import type { Page } from 'playwright';
import { createCdpSession, type DriverSession } from './drivers/cdp.js';
import { createSyntheticSession } from './drivers/synthetic.js';
import { ImeplayError } from './errors.js';
import { judge, type Finding, type Submission, type SubmitPhase, type Verdict } from './judge.js';
import { koreanSteps } from './korean.js';
import { resolveProfiles, type BrowserName, type Profile } from './profiles.js';
import { validateSteps, type ImeStep } from './steps.js';
import {
  extractValue,
  installWatch,
  isSubmission,
  readWatch,
  setPhase,
  settle,
  urlMatcher,
  type ImeEvent,
} from './watch.js';

export interface TypeWithImeOptions {
  /** 어떤 프로필로 입력할지. 기본: Chromium 이면 'cdp', Firefox 면 'firefox', WebKit 이면 'safari'. */
  profile?: Profile;
  /** 조합 단계를 직접 줄 때(일본어·중국어 등). 없으면 koreanSteps(text). */
  steps?: ImeStep[];
}

/** typeWithIme 가 돌려주는 조합 상태. 마지막 음절이 아직 조합 중이다. */
export interface ImeSession {
  readonly profile: Profile;
  /** 아직 확정되지 않은 조합 문자열(없으면 null). */
  readonly composing: string | null;
  /** 프로필 순서대로 "확정용 Enter" 를 재생한다(조합 중이어야 한다). */
  pressEnterDuringComposition(): Promise<void>;
  /** CDP 세션 등 자원을 놓는다. */
  close(): Promise<void>;
}

export interface CheckOptions {
  /** 입력창 셀렉터(textarea 또는 input). */
  input: string;
  /** 입력할 문장. 마지막 글자가 한글 음절이어야 조합 중 Enter 를 시험할 수 있다. */
  text?: string;
  /** 조합 단계 직접 지정(일본어·중국어 등). text 가 없으면 단계의 최종 문자열이 기대값이다. */
  steps?: ImeStep[];
  /** 'auto'(기본) 또는 프로필 목록. */
  profiles?: 'auto' | Profile[];
  /** 전송으로 볼 요청 URL 글롭('**\/api/chat') 또는 RegExp. 없으면 GET 이 아닌 모든 요청. */
  request?: string | RegExp;
  /** true 면 요청을 가로채지 않고 실제 서버로 보낸다(기본 false — 가짜 200 응답). */
  passthrough?: boolean;
  /** true 면 리포트에 키보드·조합 이벤트 로그를 담는다. */
  recordEvents?: boolean;
  /** 입력창을 기다리는 시간(ms, 기본 30000). */
  timeout?: number;
}

export interface ImeReport {
  profile: Profile;
  /** 기대한 메시지. */
  text: string;
  verdict: Verdict;
  findings: Finding[];
  submissions: Submission[];
  /** recordEvents: true 일 때만. */
  events?: ImeEvent[];
}

/** 페이지의 브라우저 종류를 알아낸다. */
export async function detectBrowserName(page: Page): Promise<BrowserName> {
  const name = page.context().browser()?.browserType().name();
  if (name === 'chromium' || name === 'firefox' || name === 'webkit') return name;
  // persistent context 처럼 browser() 가 없을 때는 userAgent 로 짐작한다.
  const ua = await page.evaluate(() => navigator.userAgent);
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\//.test(ua)) return 'chromium';
  return 'webkit';
}

function defaultProfile(browserName: BrowserName): Profile {
  return browserName === 'chromium' ? 'cdp' : browserName === 'firefox' ? 'firefox' : 'safari';
}

/**
 * 입력창에 IME 로 글자를 친다. 마지막 음절은 조합 중으로 남는다.
 * 이어서 `session.pressEnterDuringComposition()` 으로 "확정용 Enter" 를 누를 수 있다.
 */
export async function typeWithIme(
  page: Page,
  selector: string,
  text: string,
  opts: TypeWithImeOptions = {},
): Promise<ImeSession> {
  const browserName = await detectBrowserName(page);
  const profile = opts.profile ?? defaultProfile(browserName);
  resolveProfiles(browserName, [profile]); // Chromium 이 아닌데 cdp 면 UnsupportedProfileError
  const steps = opts.steps ?? koreanSteps(text);
  validateSteps(steps);

  const target = page.locator(selector).first();
  await target.focus();
  const driver: DriverSession = profile === 'cdp' ? await createCdpSession(page) : createSyntheticSession(target, profile);
  try {
    await driver.play(steps);
  } catch (err) {
    await driver.close();
    throw err;
  }
  return {
    profile,
    get composing() {
      return driver.composing;
    },
    async pressEnterDuringComposition() {
      if (driver.composing === null) {
        throw new ImeplayError(
          'nothing is composing: the text must end with a Hangul syllable (or the steps with a compose step) to press Enter during composition',
        );
      }
      await driver.pressEnterDuringComposition();
    },
    close: () => driver.close(),
  };
}

/**
 * 프로필마다: 페이지를 새로 로드 → 입력 → 확정용 Enter → 진짜 Enter → 전송 기록으로 판정.
 * 페이지는 미리 page.goto(...) 로 열어 둔다(같은 URL 을 프로필마다 다시 연다).
 */
export async function checkIme(page: Page, opts: CheckOptions): Promise<ImeReport[]> {
  if (!opts || typeof opts.input !== 'string' || opts.input === '') {
    throw new ImeplayError("checkIme: 'input' (a selector for the textarea/input) is required");
  }
  if (opts.text === undefined && opts.steps === undefined) {
    throw new ImeplayError("checkIme: give 'text' (Korean is converted automatically) or 'steps'");
  }
  const steps = opts.steps ?? koreanSteps(opts.text!);
  const { composing, finalText } = validateSteps(steps);
  const expected = opts.text ?? finalText;
  if (opts.steps && opts.text !== undefined && finalText !== opts.text) {
    throw new ImeplayError(`checkIme: steps produce ${JSON.stringify(finalText)} but text is ${JSON.stringify(opts.text)}`);
  }
  if (composing === null) {
    throw new ImeplayError(
      `checkIme: ${JSON.stringify(expected)} does not end while composing — end the text with a Hangul syllable (e.g. '안녕')`,
    );
  }

  const url = page.url();
  if (!/^(https?|file):/.test(url)) {
    throw new ImeplayError(`checkIme: open the page with page.goto() first (current URL: ${url})`);
  }
  const browserName = await detectBrowserName(page);
  const profiles = resolveProfiles(browserName, opts.profiles ?? 'auto');
  const matcher = urlMatcher(opts.request);
  const timeout = opts.timeout ?? 30_000;

  // 감시(init script)와 가짜 응답(route)은 이 호출 동안만 깔고, 끝나면 걷어 낸다.
  const watch = await installWatch(page, { request: opts.request, passthrough: opts.passthrough });
  const reports: ImeReport[] = [];
  try {
    for (const profile of profiles) {
      // 1) 새로 로드(init script 가 감시를 깔고, 이전 프로필의 상태를 지운다)
      await page.goto(url, { waitUntil: 'load', timeout });
      await page.locator(opts.input).first().waitFor({ state: 'visible', timeout });

      // 2) 조합 입력 — 마지막 음절은 조합 중
      await setPhase(page, 'typing');
      const session = await typeWithIme(page, opts.input, expected, { profile, steps });
      try {
        await settle(page);
        // 3) 확정용 Enter(IME 가 받는 Enter)
        await setPhase(page, 'ime-enter');
        await session.pressEnterDuringComposition();
        await settle(page);
        // 4) 진짜 전송 Enter
        await setPhase(page, 'submit-enter');
        await page.keyboard.press('Enter');
        await settle(page);
      } finally {
        await session.close();
      }

      // 5) 기록 읽기 → 판정
      const snapshot = await readWatch(page);
      await setPhase(page, 'done');
      if (!snapshot.installed) {
        throw new ImeplayError('checkIme: the watch script did not load on this page (was the page replaced by a non-HTML document?)');
      }
      const submissions: Submission[] = snapshot.records
        .filter((r) => r.phase === 'typing' || r.phase === 'ime-enter' || r.phase === 'submit-enter')
        .filter((r) => isSubmission(r.method, r.url, matcher))
        .map((r) => ({ value: extractValue(r.body), phase: r.phase as SubmitPhase, url: r.url, method: r.method, kind: r.kind }));
      const { verdict, findings } = judge(expected, submissions);
      const report: ImeReport = { profile, text: expected, verdict, findings, submissions };
      if (opts.recordEvents) report.events = snapshot.events;
      reports.push(report);
    }
  } finally {
    await watch.dispose();
  }
  return reports;
}
