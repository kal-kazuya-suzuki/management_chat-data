/**
 * Gmail の OAuth 2.0 認証。
 *
 * デスクトップアプリ用のクライアントで、ループバック（http://127.0.0.1:ポート）に
 * リダイレクトする方式を使う。Google が 2022 年に廃止した OOB（コピペ）方式は使わない。
 *
 * 流れ:
 *   1. 初回だけ `npm run gmail:auth` で同意画面を開き、リフレッシュトークンを得る
 *   2. 以降はリフレッシュトークンからアクセストークンを取り直す（ブラウザ不要）
 *
 * OAuth 同意画面の User type を「内部」にしておくこと。
 * 「テスト中」の外部アプリだと、リフレッシュトークンが7日で失効する。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import * as log from '../util/log.js';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export class GmailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthError';
  }
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * アクセストークンを取得し、期限内は使い回す。
 * Gmail のアクセストークンは1時間で切れるので、少し早めに取り直す。
 */
export class AccessTokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private readonly tokenEndpoint: string;

  constructor(
    private readonly credentials: OAuthCredentials & { tokenEndpoint?: string },
    private readonly now: () => number = () => Date.now(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.tokenEndpoint = credentials.tokenEndpoint ?? TOKEN_ENDPOINT;
  }

  async getAccessToken(): Promise<string> {
    // 期限の60秒前には取り直す
    if (this.token !== null && this.now() < this.expiresAt - 60_000) return this.token;

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const json = (await response.json()) as TokenResponse;

    if (!response.ok || !json.access_token) {
      throw new GmailAuthError(
        `アクセストークンの取得に失敗しました: ${json.error ?? response.status}` +
          (json.error_description ? `\n  ${json.error_description}` : '') +
          (json.error === 'invalid_grant'
            ? '\n  リフレッシュトークンが失効している可能性があります。`npm run gmail:auth` をやり直してください。' +
              '\n  （OAuth 同意画面が「テスト中」だと7日で失効します。User type を「内部」にしてください）'
            : ''),
      );
    }

    this.token = json.access_token;
    this.expiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
    return this.token;
  }
}

/** ブラウザで URL を開く（開けなくても URL は表示するので手動で開ける）。 */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // 開けなくても続行する（URL は表示済み）
  }
}

/** PKCE の verifier / challenge を作る。 */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * 同意フローを実行してリフレッシュトークンを得る。
 * ループバックサーバを一時的に立て、ブラウザからの認可コードを受け取る。
 */
export async function runAuthorizationFlow(options: {
  clientId: string;
  clientSecret: string;
  port?: number;
  timeoutMs?: number;
}): Promise<{ refreshToken: string; scope: string }> {
  const port = options.port ?? 8765;
  const redirectUri = `http://127.0.0.1:${port}`;
  const state = randomBytes(16).toString('hex');
  const { verifier, challenge } = createPkcePair();

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', options.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', GMAIL_READONLY_SCOPE);
  // リフレッシュトークンを確実に受け取るため
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const code = await waitForAuthorizationCode({
    port,
    state,
    authUrl: authUrl.toString(),
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
  });

  const body = new URLSearchParams({
    code,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await response.json()) as TokenResponse & { scope?: string };

  if (!response.ok || !json.refresh_token) {
    throw new GmailAuthError(
      `トークンの交換に失敗しました: ${json.error ?? response.status}` +
        (json.error_description ? `\n  ${json.error_description}` : '') +
        (!json.refresh_token && response.ok
          ? '\n  リフレッシュトークンが返りませんでした。既に同意済みのアプリでは返らないことがあります。' +
            '\n  https://myaccount.google.com/permissions でアクセス権を削除してからやり直してください。'
          : ''),
    );
  }

  return { refreshToken: json.refresh_token, scope: json.scope ?? GMAIL_READONLY_SCOPE };
}

/** ループバックサーバを立てて認可コードを待つ。 */
function waitForAuthorizationCode(options: {
  port: number;
  state: string;
  authUrl: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${options.port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');

      const reply = (message: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:2rem">
           <p>${message}</p><p>このタブは閉じて構いません。</p></body>`,
        );
      };

      if (error) {
        reply(`認証がキャンセルされました: ${error}`);
        finish(new GmailAuthError(`認証がキャンセルされました: ${error}`));
        return;
      }
      if (!code) {
        // favicon など、認可以外のリクエストは無視する
        res.writeHead(404).end();
        return;
      }
      if (state !== options.state) {
        reply('state が一致しませんでした。安全のため中止します。');
        finish(new GmailAuthError('state が一致しませんでした（CSRF の可能性）。もう一度やり直してください。'));
        return;
      }

      reply('認証が完了しました。ターミナルに戻ってください。');
      finish(null, code);
    });

    let settled = false;
    const timer = setTimeout(() => {
      finish(new GmailAuthError('認証がタイムアウトしました（5分）。もう一度やり直してください。'));
    }, options.timeoutMs);

    function finish(error: Error | null, code?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {
        if (error) reject(error);
        else resolve(code as string);
      });
    }

    server.on('error', (error) => {
      finish(
        new GmailAuthError(
          `ループバックサーバを起動できませんでした（ポート ${options.port}）: ${error.message}\n` +
            '  --port で別のポートを指定してください（Google Cloud 側のリダイレクト URI も合わせること）。',
        ),
      );
    });

    server.listen(options.port, '127.0.0.1', () => {
      log.info('ブラウザで同意画面を開きます。開かない場合は以下の URL を貼り付けてください:');
      log.info('');
      log.info(`  ${options.authUrl}`);
      log.info('');
      log.info('認証を待っています…');
      openBrowser(options.authUrl);
    });
  });
}
