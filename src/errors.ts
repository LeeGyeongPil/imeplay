// imeplay 가 던지는 예외들. 모두 ImeplayError 를 상속하므로 `instanceof ImeplayError` 로 한 번에 잡을 수 있다.

/** imeplay 의 모든 예외가 상속하는 기반 클래스. */
export class ImeplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImeplayError';
  }
}

/** 이 브라우저에서 쓸 수 없는 프로필을 요청했을 때(예: Firefox 에서 `cdp`). */
export class UnsupportedProfileError extends ImeplayError {
  readonly profile: string;
  readonly browserName: string;

  constructor(profile: string, browserName: string) {
    super(
      `profile '${profile}' is not supported on ${browserName}: ` +
        `'cdp' needs a Chromium-based browser (CDP sessions are Chromium-only). ` +
        `Use the synthetic profiles 'chromium', 'firefox' or 'safari' instead.`,
    );
    this.name = 'UnsupportedProfileError';
    this.profile = profile;
    this.browserName = browserName;
  }
}

/** expectSingleSubmit 이 실패했을 때. message 에 프로필·판정·전송 목록이 담긴다. */
export class ImeAssertionError extends ImeplayError {
  constructor(message: string) {
    super(message);
    this.name = 'ImeAssertionError';
  }
}
