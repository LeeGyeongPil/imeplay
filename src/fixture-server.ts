// 연습용 목(mock) 채팅 화면을 내주는 작은 로컬 서버(node:http).
//   GET  /chat.html?mode=buggy|composing-only|fixed   채팅 화면
//   POST /api/chat                                     정해진 목 응답 { reply: '(mock) 받았습니다: …' }
// - 127.0.0.1 의 임의 포트(0)에만 연다.
// - 잊고 닫지 않아도 유휴 시간·전체 시간이 지나면 스스로 닫힌다(타이머는 프로세스 종료를 막지 않는다).
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServerOptions {
  /** 요청이 없으면 이 시간(ms) 뒤 닫는다. 기본 120000. 0 이면 끔. */
  idleTimeout?: number;
  /** 열린 뒤 이 시간(ms)이 지나면 무조건 닫는다. 기본 600000. 0 이면 끔. */
  maxLifetime?: number;
}

export interface FixtureServer {
  /** 예: http://127.0.0.1:53817 */
  readonly url: string;
  /** 서버가 실제로 받은 POST /api/chat 메시지들(최근 1000개). route 스텁이 가로채면 비어 있다. */
  readonly posts: readonly string[];
  /** 서버를 닫는다. 여러 번 불러도 된다. */
  close(): Promise<void>;
}

export const FIXTURE_MODES = ['buggy', 'composing-only', 'fixed'] as const;
export type FixtureMode = (typeof FIXTURE_MODES)[number];

const CHAT_HTML = new URL('../fixtures/chat.html', import.meta.url);
const MAX_POSTS = 1000;
const MAX_BODY = 64 * 1024;

export async function startFixtureServer(opts: FixtureServerOptions = {}): Promise<FixtureServer> {
  const html = await readFile(CHAT_HTML, 'utf8');
  const posts: string[] = [];
  const idleTimeout = opts.idleTimeout ?? 120_000;
  const maxLifetime = opts.maxLifetime ?? 600_000;

  const server = createServer((req, res) => {
    touch();
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && (path === '/' || path === '/chat.html' || path === '/chat')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'POST' && path === '/api/chat') {
      const body = await readBody(req);
      let message = body;
      try {
        message = String(JSON.parse(body).message ?? body);
      } catch {
        // JSON 이 아니면 본문 그대로
      }
      posts.push(message);
      if (posts.length > MAX_POSTS) posts.shift();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply: `(mock) 받았습니다: ${message}`, imeplay: 'fixture-server' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  // 유휴·전체 타임아웃 — unref() 라서 이 타이머 때문에 Node 프로세스가 안 끝나는 일은 없다.
  let idleTimer: NodeJS.Timeout | undefined;
  function touch() {
    if (idleTimeout <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), idleTimeout);
    idleTimer.unref();
  }
  const lifeTimer = maxLifetime > 0 ? setTimeout(() => void close(), maxLifetime) : undefined;
  lifeTimer?.unref();

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (lifeTimer) clearTimeout(lifeTimer);
      server.close(() => resolve());
      server.closeAllConnections(); // keep-alive 연결까지 끊어야 close 콜백이 바로 온다
    });
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  touch();
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, posts, close };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 픽스처 화면 주소: `${server.url}/chat.html?mode=buggy` */
export function fixtureUrl(server: Pick<FixtureServer, 'url'>, mode: FixtureMode): string {
  return `${server.url}/chat.html?mode=${mode}`;
}
