#!/usr/bin/env node
// imeplay CLI
//   imeplay demo                      연습용 목 채팅 화면 3종 × IME 프로필 4개 행렬
//   imeplay check <url|fixture:NAME>  아무 화면의 입력창을 바로 점검 (--steps FILE 로 일본어·중국어 등 조합 단계를 직접 지정)
// 종료코드: 0 = 모두 PASS(또는 --exit-zero), 1 = FAIL 있음, 2 = 사용법 오류·실행 오류·시간 초과
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser, BrowserContext, Page } from 'playwright';
import { describeReport } from './assert.js';
import { checkIme, type ImeReport } from './check.js';
import { ImeplayError } from './errors.js';
import { FIXTURE_MODES, fixtureUrl, startFixtureServer, type FixtureMode, type FixtureServer } from './fixture-server.js';
import { formatSubmissions } from './judge.js';
import { browserTypeFor, isBrowserName, resolveLaunchOptions } from './launch.js';
import { parseProfiles, resolveProfiles, type BrowserName, type Profile } from './profiles.js';
import { validateSteps, type ImeStep } from './steps.js';

const HELP = `imeplay — reproduce IME composition (Korean) in a real browser and check Enter-to-send inputs

Usage
  imeplay demo [--screenshots DIR] [--browser chromium] [--timeout 60] [--json]
  imeplay check <url | fixture:buggy|composing-only|fixed> [options]

Options (check)
  --input SEL          input/textarea selector (default: '#prompt' for fixtures, 'textarea' for URLs)
  --text TEXT          text to type with the IME, must end with a Hangul syllable (default: 안녕)
  --steps FILE         JSON array of IME steps (compose/commit/insert) for Japanese, Chinese etc.; not with --text
  --profiles LIST      auto | comma list of cdp,chromium,firefox,safari (default: auto)
  --request GLOB       URL glob that counts as "send", e.g. '**/api/chat' (default: any non-GET request)
  --passthrough        let matching requests reach the real server (default: answer them with a fake 200)
  --browser NAME       chromium | firefox | webkit (default: chromium)
  --json               print a JSON report to stdout
  --exit-zero          exit 0 even when a profile FAILs
  --timeout SEC        stop everything after SEC seconds and exit 2 (default: 60)
  --chromium-arg=ARG   extra Chromium flag, repeatable (env IMEPLAY_CHROMIUM_ARGS works too)
  --screenshots DIR    save a PNG per fixture (demo) or per profile (check)

Exit codes: 0 all PASS · 1 some FAIL · 2 usage error, runtime error or timeout`;

// demo 가 기대하는 행렬: buggy 는 모두 FAIL, isComposing 만 본 수정은 safari 만 FAIL, 제대로 고친 것은 모두 PASS
const EXPECTED: Record<FixtureMode, Record<Profile, 'PASS' | 'FAIL'>> = {
  buggy: { cdp: 'FAIL', chromium: 'FAIL', firefox: 'FAIL', safari: 'FAIL' },
  'composing-only': { cdp: 'PASS', chromium: 'PASS', firefox: 'PASS', safari: 'FAIL' },
  fixed: { cdp: 'PASS', chromium: 'PASS', firefox: 'PASS', safari: 'PASS' },
};

interface Resources {
  browser?: Browser;
  server?: FixtureServer;
}

type Values = {
  input?: string;
  text?: string;
  steps?: string;
  profiles?: string;
  request?: string;
  browser?: string;
  json?: boolean;
  'exit-zero'?: boolean;
  timeout?: string;
  'chromium-arg'?: string[];
  passthrough?: boolean;
  screenshots?: string;
  help?: boolean;
  version?: boolean;
};

const out = (line = '') => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);
const pass = (r: ImeReport) => r.verdict === 'PASS';
const cell = (r: ImeReport) => (pass(r) ? 'PASS' : 'FAIL');
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - [...s].length));

class UsageError extends ImeplayError {}
/** 브라우저 시작 실패. 메시지에 고치는 방법이 들어 있으므로 줄이지 않고 전부 보여 준다. */
class LaunchError extends ImeplayError {}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        input: { type: 'string' },
        text: { type: 'string' },
        steps: { type: 'string' },
        profiles: { type: 'string' },
        request: { type: 'string' },
        browser: { type: 'string' },
        json: { type: 'boolean' },
        'exit-zero': { type: 'boolean' },
        timeout: { type: 'string' },
        'chromium-arg': { type: 'string', multiple: true },
        passthrough: { type: 'boolean' },
        screenshots: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (e) {
    err(`imeplay: ${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const values = parsed.values as Values;
  const [command, target, ...extra] = parsed.positionals;

  if (values.version) {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    out(pkg.version);
    return 0;
  }
  if (values.help || command === undefined || command === 'help') {
    out(HELP);
    return command === undefined && !values.help ? 2 : 0;
  }
  if (extra.length > 0) {
    err(`imeplay: unexpected arguments: ${extra.join(' ')}`);
    return 2;
  }

  const timeoutSec = values.timeout === undefined ? 60 : Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    err(`imeplay: --timeout must be a positive number of seconds (got ${values.timeout})`);
    return 2;
  }

  // 잘못된 --browser 는 서버·브라우저를 띄우기 전에 거른다.
  if (values.browser !== undefined && !isBrowserName(values.browser)) {
    err(`imeplay: --browser must be chromium, firefox or webkit (got ${values.browser})`);
    return 2;
  }

  // --steps 는 check 전용이며 --text 와 함께 쓸 수 없다. 파일 검증도 서버·브라우저를 띄우기 전에 끝낸다.
  let stepsInput: StepsInput | undefined;
  if (values.steps !== undefined) {
    if (command === 'demo') {
      err('imeplay: --steps is only for check');
      return 2;
    }
    if (values.text !== undefined) {
      err('imeplay: --steps and --text cannot be used together');
      return 2;
    }
    const loaded = await loadSteps(values.steps);
    if (typeof loaded === 'string') {
      err(`imeplay: ${loaded}`);
      return 2;
    }
    stepsInput = loaded;
  }

  // 전체 시간 상한: 시간이 다 되면 브라우저·서버를 닫고 종료코드 2 로 끝낸다.
  const resources: Resources = {};
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      err(`imeplay: timeout after ${timeoutSec}s — closing the browser and server`);
      resolve(2);
    }, timeoutSec * 1000);
  });
  // Ctrl+C 에도 정리하고 끝낸다.
  const onSignal = (signal: NodeJS.Signals) => {
    err(`imeplay: ${signal} — closing the browser and server`);
    void cleanup(resources).then(() => {
      process.exitCode = 130;
      forceExitLater(130);
    });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const run = (async () => {
    if (command === 'demo') {
      if (target !== undefined) throw new UsageError(`demo takes no target (got ${target})`);
      return demo(values, resources);
    }
    if (command === 'check') {
      if (target === undefined) throw new UsageError('check needs a target: a URL or fixture:buggy|composing-only|fixed');
      return check(target, values, resources, stepsInput);
    }
    throw new UsageError(`unknown command '${command}' (expected demo or check)`);
  })().catch((e: unknown) => {
    if (timedOut) return 2; // 시간 초과로 브라우저를 닫아 생긴 오류는 덮는다
    if (e instanceof UsageError) {
      err(`imeplay: ${e.message}\n\n${HELP}`);
    } else {
      const version = resources.browser?.isConnected() ? ` (browser ${resources.browser.version()})` : '';
      // Playwright 오류는 브라우저 로그가 길게 붙으므로 첫 줄만 보여 준다(IMEPLAY_DEBUG=1 이면 전부).
      const message = e instanceof Error ? e.message : String(e);
      err(`imeplay: error${version}: ${process.env.IMEPLAY_DEBUG || e instanceof LaunchError ? message : message.split('\n')[0]}`);
    }
    return 2;
  });

  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup(resources);
  }
}

interface StepsInput {
  steps: ImeStep[];
  finalText: string;
}

/** --steps 파일을 읽고 검증한다. 실패하면 한 줄 오류 문구(문자열)를 돌려준다. */
async function loadSteps(file: string): Promise<StepsInput | string> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    return `--steps: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return `--steps: ${file} is not valid JSON (${(e as Error).message.split('\n')[0]})`;
  }
  try {
    const { composing, finalText } = validateSteps(data as ImeStep[]);
    if (composing === null) {
      return `--steps: ${file}: the last step must be a compose step so Enter can be pressed during composition`;
    }
    return { steps: data as ImeStep[], finalText };
  } catch (e) {
    if (e instanceof ImeplayError) return `--steps: ${file}: ${e.message.split('\n')[0]}`;
    throw e;
  }
}

/** 브라우저·서버를 닫는다. 닫기가 멈춰도 5초 뒤에는 넘어간다. */
async function cleanup(resources: Resources): Promise<void> {
  const { browser, server } = resources;
  resources.browser = undefined;
  resources.server = undefined;
  let guard: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([browser?.close(), server?.close()]),
    new Promise<void>((resolve) => {
      guard = setTimeout(resolve, 5000);
    }),
  ]);
  clearTimeout(guard);
}

/** 정리 뒤에도 무언가가 이벤트 루프를 붙잡고 있으면 2초 뒤 강제로 끝낸다(평소엔 그 전에 자연 종료). */
function forceExitLater(code: number) {
  setTimeout(() => process.exit(code), 2000).unref();
}

/** 브라우저가 시작 직후 죽었을 때 원인 후보와 고칠 방법을 덧붙인 메시지를 만든다. */
function launchFailureMessage(e: unknown, browserName: string): string {
  const first = (e as Error).message.split('\n')[0] ?? String(e);
  const hint =
    browserName === 'chromium'
      ? 'If this runs inside a sandbox or container, retry with IMEPLAY_CHROMIUM_ARGS="--single-process --no-zygote" ' +
        '(or add --chromium-arg). If the browser binary is missing, run: npx playwright install chromium. ' +
        'Set IMEPLAY_DEBUG=1 for the full browser log.'
      : `If the browser binary is missing, run: npx playwright install ${browserName}. Set IMEPLAY_DEBUG=1 for the full browser log.`;
  return `could not start ${browserName}: ${first}\n${hint}`;
}

async function launch(
  values: Values,
  resources: Resources,
): Promise<{ browser: Browser; context: BrowserContext; browserName: BrowserName }> {
  const browserName = values.browser ?? 'chromium';
  if (!isBrowserName(browserName)) throw new UsageError(`--browser must be chromium, firefox or webkit (got ${browserName})`);
  const type = await browserTypeFor(browserName);
  // Chromium 에만 IMEPLAY_CHROMIUM_ARGS·--chromium-arg 를 넣는다.
  const options = browserName === 'chromium' ? resolveLaunchOptions(process.env, values['chromium-arg'] ?? []) : {};
  let browser: Browser;
  try {
    browser = await type.launch({ headless: true, ...options });
  } catch (e) {
    throw new LaunchError(launchFailureMessage(e, browserName));
  }
  resources.browser = browser;
  // 컨텍스트는 하나만 만들고 그 안에서 페이지를 새로 연다.
  // (--single-process Chromium 은 두 번째 컨텍스트를 만들면 죽는다 — 샌드박스에서 확인)
  const context = await browser.newContext();
  return { browser, context, browserName };
}

async function screenshot(page: Page, dir: string, name: string): Promise<string> {
  // 목 응답 말풍선이 다 그려질 때까지 잠깐 기다린다(최대 2초, 못 기다려도 그대로 찍는다).
  await page
    .waitForFunction(() => document.querySelectorAll('.msg.user').length <= document.querySelectorAll('.msg.bot').length, null, {
      timeout: 2000,
    })
    .catch(() => {});
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

// ---------------------------------------------------------------- demo
async function demo(values: Values, resources: Resources): Promise<number> {
  const server = await startFixtureServer();
  resources.server = server;
  const { browser, context, browserName } = await launch(values, resources);
  const profiles = resolveProfiles(browserName, 'auto');
  const text = '안녕';

  const matrix: Record<string, ImeReport[]> = {};
  const shots: string[] = [];
  for (const mode of FIXTURE_MODES) {
    const page = await context.newPage();
    try {
      await page.goto(fixtureUrl(server, mode));
      const reports: ImeReport[] = [];
      for (const profile of profiles) {
        reports.push(...(await checkIme(page, { input: '#prompt', text, profiles: [profile], recordEvents: values.json })));
        // 첫 프로필(Chromium 이면 실제 이벤트인 cdp)이 끝난 화면을 남긴다 — buggy 면 '안녕'·'녕' 말풍선 두 개
        if (values.screenshots && profile === profiles[0]) shots.push(await screenshot(page, values.screenshots, mode));
      }
      matrix[mode] = reports;
    } finally {
      await page.close();
    }
  }

  // 기대 행렬과 비교
  const mismatches: string[] = [];
  for (const mode of FIXTURE_MODES) {
    for (const r of matrix[mode]!) {
      if (cell(r) !== EXPECTED[mode][r.profile]) mismatches.push(`${mode}/${r.profile}: expected ${EXPECTED[mode][r.profile]}, got ${cell(r)}`);
    }
  }

  if (values.json) {
    out(
      JSON.stringify(
        { command: 'demo', mock: true, browser: browserName, browserVersion: browser.version(), text, profiles, matrix, matchesExpected: mismatches.length === 0, mismatches, screenshots: shots },
        null,
        2,
      ),
    );
  } else {
    out(`imeplay demo — 연습용 목(mock) 채팅 화면 3종 × IME 프로필 ${profiles.length}개`);
    out(`text '${text}' · ${browserName} ${browser.version()} · server ${server.url} (요청은 가짜 200 응답으로 가로챔)`);
    out();
    out(pad('fixture', 17) + profiles.map((p) => pad(p, 10)).join('').trimEnd());
    for (const mode of FIXTURE_MODES) out(pad(mode, 17) + matrix[mode]!.map((r) => pad(cell(r), 10)).join('').trimEnd());
    out();
    out('FAIL details');
    for (const mode of FIXTURE_MODES) {
      for (const r of matrix[mode]!.filter((x) => !pass(x))) out(`  ${mode}/${describeReport(r)}`);
    }
    if (shots.length > 0) {
      out();
      out(`screenshots: ${shots.join(', ')}`);
    }
    out();
    out(mismatches.length === 0 ? 'matches the expected matrix: yes' : `matches the expected matrix: NO\n  ${mismatches.join('\n  ')}`);
  }
  return mismatches.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- check
async function check(target: string, values: Values, resources: Resources, stepsInput?: StepsInput): Promise<number> {
  let url: string;
  let isFixture = false;
  if (target.startsWith('fixture:')) {
    const mode = target.slice('fixture:'.length) as FixtureMode;
    if (!FIXTURE_MODES.includes(mode)) throw new UsageError(`unknown fixture '${mode}' (expected ${FIXTURE_MODES.join(', ')})`);
    const server = await startFixtureServer();
    resources.server = server;
    err(`imeplay: fixture server ${server.url} (연습용 목(mock) 채팅 화면)`);
    url = fixtureUrl(server, mode);
    isFixture = true;
  } else if (/^(https?|file):/.test(target)) {
    url = target;
  } else {
    throw new UsageError(`target must be an http(s)/file URL or fixture:NAME (got ${target})`);
  }

  const input = values.input ?? (isFixture ? '#prompt' : 'textarea');
  const text = stepsInput?.finalText ?? values.text ?? '안녕';
  const { browser, context, browserName } = await launch(values, resources);
  const profiles = resolveProfiles(browserName, parseProfiles(values.profiles));
  const page = await context.newPage();
  await page.goto(url);

  const reports: ImeReport[] = [];
  const shots: string[] = [];
  for (const profile of profiles) {
    reports.push(
      ...(await checkIme(page, {
        input,
        // --steps 일 때는 steps 만 넘긴다(text 는 finalText 로 표시용)
        ...(stepsInput ? { steps: stepsInput.steps } : { text }),
        profiles: [profile],
        request: values.request,
        passthrough: values.passthrough,
        recordEvents: values.json,
      })),
    );
    if (values.screenshots) shots.push(await screenshot(page, values.screenshots, profile));
  }
  await page.close();

  const failed = reports.filter((r) => !pass(r));
  if (values.json) {
    out(
      JSON.stringify(
        {
          command: 'check',
          target,
          url,
          mock: isFixture,
          browser: browserName,
          browserVersion: browser.version(),
          input,
          text,
          ...(values.steps !== undefined ? { steps: values.steps } : {}),
          requests: values.passthrough ? 'passthrough' : 'stubbed',
          ok: failed.length === 0,
          reports,
          screenshots: shots,
        },
        null,
        2,
      ),
    );
  } else {
    out(`imeplay check — ${url}${isFixture ? '  [연습용 목(mock) 채팅 화면]' : ''}`);
    out(
      `input ${input} · text '${text}'${values.steps !== undefined && stepsInput ? ` (steps ${values.steps}, ${stepsInput.steps.length} steps)` : ''} · ${browserName} ${browser.version()} · requests ${values.passthrough ? 'passthrough (real server)' : 'stubbed (fake 200)'}`,
    );
    out();
    out(pad('profile', 10) + pad('sent', 6) + pad('values', 40) + 'verdict');
    for (const r of reports) {
      const verdict = pass(r) ? 'PASS' : `FAIL ${r.findings.map((f) => f.code).join('+')}`;
      out(pad(r.profile, 10) + pad(String(r.submissions.length), 6) + pad(formatSubmissions(r.submissions), 40) + verdict);
    }
    for (const r of failed) for (const f of r.findings) out(`  ${r.profile}: ${f.code} — ${f.message}`);
    if (shots.length > 0) out(`screenshots: ${shots.join(', ')}`);
    out();
    out(failed.length === 0 ? `result: all ${reports.length} profile(s) PASS` : `result: ${failed.length} of ${reports.length} profile(s) FAIL`);
  }
  if (failed.length === 0) return 0;
  return values['exit-zero'] ? 0 : 1;
}

const code = await main(process.argv.slice(2));
process.exitCode = code;
forceExitLater(code);
