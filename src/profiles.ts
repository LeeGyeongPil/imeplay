// 프로필 = "조합 중에 Enter 를 눌렀을 때 브라우저가 이벤트를 어떤 순서로 내는가".
//
//   cdp       Chromium 이 실제로 내는 이벤트(CDP Input 도메인으로 진짜 조합을 만든다) — Chromium 전용
//   chromium  합성: keydown Enter(keyCode 229, isComposing=true) → compositionend
//   firefox   합성: keydown Enter(keyCode 229, isComposing=true) → compositionend
//   safari    합성: compositionend → keydown Enter(keyCode 229, isComposing=false)  ← WebKit bug 165004
//
// safari 순서에서는 `e.isComposing` 만 보는 핸들러가 확정용 Enter 를 전송으로 오해한다.
// 그래서 `e.isComposing || e.keyCode === 229` 로 고쳐야 모든 프로필을 통과한다.
import { ImeplayError, UnsupportedProfileError } from './errors.js';

export type Profile = 'cdp' | 'chromium' | 'firefox' | 'safari';
export type SyntheticProfile = Exclude<Profile, 'cdp'>;
export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export const ALL_PROFILES: readonly Profile[] = ['cdp', 'chromium', 'firefox', 'safari'];

/** 프로필별 "확정용 Enter" 이벤트 순서(문서·리포트 표시용 설명). */
export const PROFILE_ORDER: Record<Profile, string> = {
  cdp: 'real Chromium events: keydown Enter 229 isComposing=true → compositionend',
  chromium: 'synthetic: keydown Enter 229 isComposing=true → compositionend',
  firefox: 'synthetic: keydown Enter 229 isComposing=true → compositionend',
  safari: 'synthetic: compositionend → keydown Enter 229 isComposing=false',
};

/**
 * 브라우저 이름과 요청한 프로필로 실제로 돌릴 프로필 목록을 정한다.
 * - 'auto': chromium → cdp + 합성 3종 / firefox → firefox / webkit → safari
 * - 목록을 직접 주면 그대로 쓰되, Chromium 이 아닌데 'cdp' 가 있으면 UnsupportedProfileError
 */
export function resolveProfiles(browserName: string, requested: 'auto' | readonly Profile[] = 'auto'): Profile[] {
  if (requested === 'auto') {
    if (browserName === 'chromium') return ['cdp', 'chromium', 'firefox', 'safari'];
    if (browserName === 'firefox') return ['firefox'];
    if (browserName === 'webkit') return ['safari'];
    throw new ImeplayError(`unknown browser '${browserName}' (expected chromium, firefox or webkit)`);
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new ImeplayError(`profiles must be 'auto' or a non-empty list of ${ALL_PROFILES.join(', ')}`);
  }
  for (const profile of requested) {
    if (!ALL_PROFILES.includes(profile)) {
      throw new ImeplayError(`unknown profile '${String(profile)}' (expected ${ALL_PROFILES.join(', ')})`);
    }
    if (profile === 'cdp' && browserName !== 'chromium') {
      throw new UnsupportedProfileError(profile, browserName);
    }
  }
  return [...new Set(requested)];
}

/** CLI 의 `--profiles cdp,safari` 같은 문자열을 프로필 목록으로 바꾼다. */
export function parseProfiles(value: string | undefined): 'auto' | Profile[] {
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  return value.split(',').map((s) => s.trim()).filter(Boolean) as Profile[];
}
