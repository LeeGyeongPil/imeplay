// 브라우저 실행 옵션. 환경변수 IMEPLAY_CHROMIUM_ARGS 로 Chromium 인자를 넣을 수 있다.
// 예) 일부 샌드박스(macOS Seatbelt 등)에서는 '--single-process --no-zygote' 가 있어야 Chromium 이 뜬다.
// 일반 터미널·CI 에서는 비워 두면 된다.
import type { BrowserType, LaunchOptions } from 'playwright';
import { ImeplayError } from './errors.js';
import type { BrowserName } from './profiles.js';

/** env.IMEPLAY_CHROMIUM_ARGS 를 공백으로 나눠 launch 옵션의 args 로 만든다. 없으면 args 는 빈 배열. */
export function resolveLaunchOptions(
  env: Record<string, string | undefined> = process.env,
  extraArgs: readonly string[] = [],
): LaunchOptions & { args: string[] } {
  const fromEnv = (env.IMEPLAY_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean);
  return { args: [...fromEnv, ...extraArgs] };
}

/** 'chromium' | 'firefox' | 'webkit' 이름으로 Playwright 브라우저 종류를 고른다(CLI 용). */
export async function browserTypeFor(name: string): Promise<BrowserType> {
  const pw = await import('playwright');
  if (name === 'chromium') return pw.chromium;
  if (name === 'firefox') return pw.firefox;
  if (name === 'webkit') return pw.webkit;
  throw new ImeplayError(`unknown browser '${name}' (expected chromium, firefox or webkit)`);
}

export function isBrowserName(name: string): name is BrowserName {
  return name === 'chromium' || name === 'firefox' || name === 'webkit';
}
