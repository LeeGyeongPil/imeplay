// AC-10: 패키징 — 엔진·peer 범위·.nvmrc·bin, npm pack 목록.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('package.json: engines·peerDependencies·bin·exports', () => {
  expect(pkg.engines.node).toBe('>=22.12');
  expect(pkg.peerDependencies.playwright).toBe('>=1.65.0 <2');
  expect(pkg.bin.imeplay).toBe('dist/cli.js');
  expect(pkg.type).toBe('module');
  expect(pkg.exports['.'].import).toBe('./dist/index.js');
  // 개발 의존성은 정확한 버전으로 고정
  for (const v of Object.values(pkg.devDependencies) as string[]) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
});

test('.nvmrc 는 22', () => {
  expect(readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()).toBe('22');
});

test('npm pack --dry-run: dist·fixtures 포함, tests 미포함', () => {
  test.setTimeout(60_000);
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const [info] = JSON.parse(out) as [{ files: { path: string }[] }];
  const files = info.files.map((f) => f.path);
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'fixtures/chat.html', 'package.json', 'LICENSE']) {
    expect(files).toContain(required);
  }
  expect(files.filter((f) => f.startsWith('tests/') || f.startsWith('examples/') || f.startsWith('src/'))).toEqual([]);
});

test('dist/cli.js 는 node 로 바로 실행되는 shebang 을 가진다', () => {
  expect(readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
});

// 회귀: exports 에 import 조건만 있으면 CommonJS 프로젝트의 require('imeplay') 가
// 'No "exports" main defined' 로 실패했다(Playwright TS 테스트는 CJS 로 변환될 수 있다).
test('CommonJS 프로젝트에서 npm pack 결과를 require 로 불러올 수 있다', () => {
  test.setTimeout(90_000);
  const work = mkdtempSync(join(tmpdir(), 'imeplay-cjs-'));
  try {
    const packOut = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const [{ filename }] = JSON.parse(packOut) as [{ filename: string }];
    // tgz 를 소비 프로젝트의 node_modules/imeplay 에 풀고, peer 인 playwright 는 이 레포 것을 연결한다(오프라인).
    const nm = join(work, 'node_modules');
    mkdirSync(join(nm, 'imeplay'), { recursive: true });
    execFileSync('tar', ['-xzf', join(work, filename), '-C', join(nm, 'imeplay'), '--strip-components=1']);
    symlinkSync(join(ROOT, 'node_modules', 'playwright'), join(nm, 'playwright'), 'dir');
    symlinkSync(join(ROOT, 'node_modules', 'playwright-core'), join(nm, 'playwright-core'), 'dir');
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'cjs-consumer', private: true, type: 'commonjs' }));
    const out = execFileSync(process.execPath, ['-e', "const m = require('imeplay'); console.log(String(Object.keys(m).length > 0) + ' ' + typeof m.checkIme)"], {
      cwd: work,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('true function');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
