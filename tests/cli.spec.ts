// AC-7·AC-8·AC-9: CLI(dist/cli.js)를 자식 프로세스로 실행해 출력·종료코드·뒷정리를 확인한다.
// (npm test 가 먼저 빌드하므로 dist/ 가 있다)
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.js');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  seconds: number;
}

/** CLI 를 실행하고 끝날 때까지 기다린다. CLI 가 스스로 끝나야 하므로 여기서 kill 하지 않는다(테스트 timeout 이 상한). */
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, seconds: (Date.now() - started) / 1000 }));
  });
}

/** 포트가 닫혔는지: 연결이 거부되면 true */
function portClosed(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

/**
 * 명령줄에 marker 가 들어간 프로세스 목록. Linux 는 /proc 을 읽고, 그 밖에서는 ps 를 쓴다.
 * 샌드박스에서 ps 가 권한 오류로 막히면 null(이 확인만 건너뜀).
 */
function processesWith(marker: string): string[] | null {
  if (process.platform === 'linux' && existsSync('/proc')) {
    const found: string[] = [];
    for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmd.includes(marker)) found.push(`${pid} ${cmd}`);
      } catch {
        // 그새 끝난 프로세스
      }
    }
    return found;
  }
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((l) => l.includes(marker));
  } catch {
    return null; // PermissionError 류 — 남은 프로세스 확인만 건너뛴다
  }
}

/** 브라우저 프로세스를 나중에 찾을 수 있게 Chromium 에 무해한 표시 인자를 붙인다. */
const markerArg = (marker: string) => `--chromium-arg=--imeplay-test-marker=${marker}`;

test('demo: 3×4 행렬이 기대와 같아 종료코드 0, 60초 안에 끝나고 서버 포트가 닫힌다, PNG 3개', async () => {
  test.setTimeout(120_000);
  const shots = mkdtempSync(join(tmpdir(), 'imeplay-shots-'));
  try {
    const marker = randomUUID();
    const run = await runCli(['demo', '--screenshots', shots, markerArg(marker)]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.seconds).toBeLessThan(60);
    expect(run.stdout).toContain('연습용 목(mock)');
    expect(run.stdout).toMatch(/^buggy\s+FAIL\s+FAIL\s+FAIL\s+FAIL$/m);
    expect(run.stdout).toMatch(/^composing-only\s+PASS\s+PASS\s+PASS\s+FAIL$/m); // safari 칸만 FAIL
    expect(run.stdout).toMatch(/^fixed\s+PASS\s+PASS\s+PASS\s+PASS$/m);
    expect(run.stdout).toContain("buggy/cdp: SUBMIT_ON_IME_ENTER+TRAILING_CHAR — sent ['안녕'@ime-enter, '녕'@submit-enter]");
    expect(run.stdout).toContain('matches the expected matrix: yes');
    expect(readdirSync(shots).sort()).toEqual(['buggy.png', 'composing-only.png', 'fixed.png']);

    const serverUrl = /server (http:\/\/127\.0\.0\.1:\d+)/.exec(run.stdout)?.[1];
    expect(serverUrl).toBeTruthy();
    expect(await portClosed(serverUrl!)).toBe(true);
    const left = processesWith(marker);
    if (left !== null) expect(left).toEqual([]);
  } finally {
    rmSync(shots, { recursive: true, force: true });
  }
});

test.describe('check', () => {
  test('check fixture:composing-only --profiles safari → FAIL SUBMIT_ON_IME_ENTER, 종료코드 1', async () => {
    const run = await runCli(['check', 'fixture:composing-only', '--profiles', 'safari']);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).toContain('FAIL');
    expect(run.stdout).toContain('SUBMIT_ON_IME_ENTER');
    expect(run.stdout).toMatch(/^safari\s+1\s+\['안녕'@ime-enter\]\s+FAIL SUBMIT_ON_IME_ENTER$/m);
  });

  test('check … --exit-zero → 같은 출력, 종료코드 0', async () => {
    const run = await runCli(['check', 'fixture:composing-only', '--profiles', 'safari', '--exit-zero']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('FAIL SUBMIT_ON_IME_ENTER');
    expect(run.stdout).toContain('result: 1 of 1 profile(s) FAIL');
  });

  test('check … --json → JSON.parse 가능, reports[0].verdict 와 이벤트 로그', async () => {
    const run = await runCli(['check', 'fixture:composing-only', '--profiles', 'safari', '--json']);
    expect(run.code, run.stderr).toBe(1);
    const json = JSON.parse(run.stdout);
    expect(json.reports[0].verdict).toBe('SUBMIT_ON_IME_ENTER');
    expect(json.reports[0].profile).toBe('safari');
    expect(json.mock).toBe(true);
    expect(json.requests).toBe('stubbed');
    expect(Array.isArray(json.reports[0].events)).toBe(true);
  });

  test('check fixture:fixed → 모든 프로필 PASS, 종료코드 0', async () => {
    const run = await runCli(['check', 'fixture:fixed']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('result: all 4 profile(s) PASS');
  });

  test('check: 잘못된 사용법은 종료코드 2', async () => {
    expect((await runCli(['check'])).code).toBe(2);
    expect((await runCli(['check', 'fixture:nope'])).code).toBe(2);
    expect((await runCli(['frobnicate'])).code).toBe(2);
    expect((await runCli(['check', 'fixture:fixed', '--timeout', '-1'])).code).toBe(2);
  });
});

test('timeout: 입력창이 없으면 --timeout 5 뒤 종료코드 2 와 timeout 메시지, 서버·브라우저가 남지 않는다', async () => {
  test.setTimeout(60_000);
  const marker = randomUUID();
  const run = await runCli(['check', 'fixture:fixed', '--input', '#none', '--timeout', '5', markerArg(marker)]);
  expect(run.code).toBe(2);
  expect(run.stderr).toContain('timeout');
  expect(run.seconds).toBeLessThan(15);
  const serverUrl = /fixture server (http:\/\/127\.0\.0\.1:\d+)/.exec(run.stderr)?.[1];
  expect(serverUrl).toBeTruthy();
  expect(await portClosed(serverUrl!)).toBe(true);
  const left = processesWith(marker);
  if (left !== null) expect(left).toEqual([]);
});

test('--version 과 --help', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const version = await runCli(['--version']);
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toBe(pkg.version);
  const help = await runCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('imeplay check');
});

test('--browser 가 잘못되면 서버를 띄우기 전에 종료코드 2 로 거른다', async () => {
  const r = await runCli(['check', 'fixture:buggy', '--browser', 'opera']);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('--browser must be chromium, firefox or webkit');
  expect(r.stderr).not.toContain('fixture server');
});

// ---------------------------------------------------------------- --steps FILE
const FIX = (name: string) => join(ROOT, 'tests', 'fixtures', name);

test.describe('check --steps', () => {
  test('일본어 단계 파일 + composing-only: safari FAIL · firefox PASS, 종료코드 1, JSON 에 text·steps', async () => {
    const file = FIX('steps-ja.json');
    const run = await runCli(['check', 'fixture:composing-only', '--steps', file, '--profiles', 'safari,firefox', '--json']);
    expect(run.code, run.stderr).toBe(1);
    const json = JSON.parse(run.stdout);
    const byProfile = Object.fromEntries(json.reports.map((r: { profile: string; verdict: string }) => [r.profile, r.verdict]));
    expect(byProfile).toEqual({ safari: 'SUBMIT_ON_IME_ENTER', firefox: 'PASS' });
    expect(json.text).toBe('日本');
    expect(json.steps).toBe(file);
  });

  test('사람용 출력: text 는 finalText, 뒤에 (steps FILE, N steps)', async () => {
    const file = FIX('steps-ja.json');
    const run = await runCli(['check', 'fixture:fixed', '--steps', file, '--profiles', 'firefox']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`text '日本' (steps ${file}, 4 steps)`);
  });

  test('fixture:fixed + 단계 파일: 모든 프로필 PASS, 종료코드 0', async () => {
    const run = await runCli(['check', 'fixture:fixed', '--steps', FIX('steps-ja.json')]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('result: all 4 profile(s) PASS');
  });

  test('미사용 시 JSON 에 steps 필드가 없다(출력 불변)', async () => {
    const run = await runCli(['check', 'fixture:fixed', '--profiles', 'firefox', '--json']);
    expect(run.code, run.stderr).toBe(0);
    expect('steps' in JSON.parse(run.stdout)).toBe(false);
    expect(run.stdout).not.toContain('(steps ');
  });

  const rejected: Array<[string, string[], string]> = [
    ['없는 파일', ['check', 'fixture:fixed', '--steps', '/nonexistent/steps.json'], '--steps: cannot read /nonexistent/steps.json (ENOENT)'],
    ['잘못된 JSON', ['check', 'fixture:fixed', '--steps', FIX('steps-not-json.txt')], 'is not valid JSON ('],
    ['배열 아님', ['check', 'fixture:fixed', '--steps', FIX('steps-object.json')], 'steps must be a non-empty array'],
    ['스키마 위반(commit 이 compose 앞)', ['check', 'fixture:fixed', '--steps', FIX('steps-bad-commit.json')], 'steps[0]: commit without an active composition'],
    ['확정으로 끝남', ['check', 'fixture:fixed', '--steps', FIX('steps-ends-committed.json')], 'the last step must be a compose step so Enter can be pressed during composition'],
    ['--text 와 동시 지정', ['check', 'fixture:fixed', '--steps', FIX('steps-ja.json'), '--text', '안녕'], '--steps and --text cannot be used together'],
    ['demo 에 --steps', ['demo', '--steps', FIX('steps-ja.json')], '--steps is only for check'],
  ];
  for (const [name, args, message] of rejected) {
    test(`${name}: 종료코드 2, 한 줄 오류, 브라우저 시작 전에 끝남`, async () => {
      const run = await runCli(args);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(message);
      expect(run.stderr).not.toContain('fixture server');
      expect(run.stderr).not.toContain('Usage'); // HELP 를 붙이지 않는다
      expect(run.stderr.trim().split('\n')).toHaveLength(1);
    });
  }

  test('--help 에 --steps 가 있다', async () => {
    const help = await runCli(['--help']);
    expect(help.stdout).toContain('--steps FILE');
  });
});

test('브라우저를 시작하지 못하면 고치는 방법(IMEPLAY_CHROMIUM_ARGS·playwright install)을 알려 준다', async () => {
  test.setTimeout(60_000);
  const r = await runCli(['check', 'fixture:buggy'], { PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), 'imeplay-no-browsers-here') });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('could not start chromium');
  expect(r.stderr).toContain('IMEPLAY_CHROMIUM_ARGS="--single-process --no-zygote"');
  expect(r.stderr).toContain('npx playwright install chromium');
});
