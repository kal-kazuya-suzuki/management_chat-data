/**
 * Gmail API クライアント。
 *
 * - アクセストークンは AccessTokenProvider が期限管理する（呼び出しごとに取り直さない）
 * - 429 / 403 rateLimitExceeded は Retry-After を見て待機し、再試行する
 * - 5xx とネットワークエラーは指数バックオフで再試行する
 *
 * Gmail の割り当ては 250 units/秒/ユーザー（messages.list=5, threads.get=10 単位）。
 * 既定は余裕をもって 20 リクエスト/秒相当にしてある。
 */
import { RateLimiter, defaultSleep } from '../util/rate-limiter.js';
import * as log from '../util/log.js';
import type {
  GmailLabel,
  GmailLabelsResponse,
  GmailListResponse,
  GmailMessageRef,
  GmailProfile,
  GmailThread,
} from './types.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<Response>;

export interface TokenSource {
  getAccessToken(): Promise<string>;
}

export interface GmailClientOptions {
  tokenSource: TokenSource;
  baseUrl?: string;
  /** 対象のメールボックス。既定 'me' */
  userId?: string;
  rateLimit?: number;
  rateWindowSeconds?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

/** 再試行しても解消しないもの。 */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);
/** 403 でも一時的で、待てば直るもの。 */
const RETRYABLE_403_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
]);

const ERROR_HINTS: Record<string, string> = {
  ACCESS_TOKEN_SCOPE_INSUFFICIENT:
    'トークンのスコープが足りません。gmail.readonly を付けて `npm run gmail:auth` をやり直してください。',
  failedPrecondition:
    'Gmail API が有効になっていない可能性があります。Google Cloud コンソールで有効化してください。',
  notFound: 'メッセージまたはスレッドが見つかりません（削除された可能性があります）。',
};

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

export class GmailClient {
  private readonly baseUrl: string;
  private readonly userId: string;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly tokenSource: TokenSource;
  private requestCount = 0;
  private rateLimitHits = 0;

  constructor(options: GmailClientOptions) {
    this.tokenSource = options.tokenSource;
    this.baseUrl = (options.baseUrl ?? 'https://gmail.googleapis.com/gmail/v1').replace(/\/+$/, '');
    this.userId = options.userId ?? 'me';
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.limiter = new RateLimiter({
      limit: options.rateLimit ?? 200,
      windowSeconds: options.rateWindowSeconds ?? 10,
      minIntervalMs: options.minIntervalMs ?? 50,
      sleep: this.sleep,
      now: options.now,
      onWait: (waitMs, reason) => {
        if (waitMs >= 1000) log.step(`${reason}のため ${Math.ceil(waitMs / 1000)} 秒待機します`);
        else log.debug(`${reason}のため ${waitMs}ms 待機`);
      },
    });
  }

  get totalRequests(): number {
    return this.requestCount;
  }

  get totalRateLimitHits(): number {
    return this.rateLimitHits;
  }

  async getProfile(): Promise<GmailProfile> {
    return await this.call<GmailProfile>(`/users/${this.userId}/profile`);
  }

  async listLabels(): Promise<GmailLabel[]> {
    const response = await this.call<GmailLabelsResponse>(`/users/${this.userId}/labels`);
    return response.labels ?? [];
  }

  /** 検索条件に合うメッセージ参照の1ページ。 */
  async listMessagePage(params: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ messages: GmailMessageRef[]; nextPageToken: string | undefined }> {
    const response = await this.call<GmailListResponse>(`/users/${this.userId}/messages`, {
      q: params.query,
      maxResults: String(params.maxResults),
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
    });
    return {
      messages: response.messages ?? [],
      nextPageToken: response.nextPageToken || undefined,
    };
  }

  /** スレッド全体（相手のメールも含む）を取得する。 */
  async getThread(threadId: string): Promise<GmailThread> {
    return await this.call<GmailThread>(`/users/${this.userId}/threads/${encodeURIComponent(threadId)}`, {
      format: 'full',
    });
  }

  private async call<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.baseUrl}${path}${search ? `?${search}` : ''}`;

    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      const accessToken = await this.tokenSource.getAccessToken();
      this.requestCount += 1;
      log.debug(`GET ${path} (試行 ${attempt + 1})`);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });
      } catch (cause) {
        if (attempt >= this.maxRetries) {
          throw new Error(`通信に失敗しました: ${path} (${String(cause)})`);
        }
        const waitMs = this.backoffMs(attempt);
        log.warn(`通信エラー。${Math.ceil(waitMs / 1000)} 秒後に再試行します (${String(cause)})`);
        this.limiter.pauseFor(waitMs);
        attempt += 1;
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const body = (await this.safeJson(response)) as GoogleErrorBody;
      const reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? '';
      const detail = body.error?.message ?? '';

      const isRateLimited =
        response.status === 429 || (response.status === 403 && RETRYABLE_403_REASONS.has(reason));

      if (isRateLimited) {
        this.rateLimitHits += 1;
        if (attempt >= this.maxRetries) {
          throw new GmailApiError(`レート制限が解消しませんでした: ${path}`, response.status, reason);
        }
        const waitMs = this.retryAfterMs(response, attempt);
        this.limiter.pauseFor(waitMs);
        log.warn(`レート制限。${Math.ceil(waitMs / 1000)} 秒待機して再試行します`);
        attempt += 1;
        continue;
      }

      if (NON_RETRYABLE_STATUS.has(response.status) || attempt >= this.maxRetries) {
        const hint = ERROR_HINTS[reason];
        throw new GmailApiError(
          `Gmail API エラー ${response.status}: ${path}\n  ${detail}` + (hint ? `\n  ${hint}` : ''),
          response.status,
          reason,
        );
      }

      const waitMs = this.backoffMs(attempt);
      log.warn(`HTTP ${response.status}。${Math.ceil(waitMs / 1000)} 秒後に再試行します`);
      this.limiter.pauseFor(waitMs);
      attempt += 1;
    }
  }

  private retryAfterMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000 + 500, 10 * 60_000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, Math.min(date - this.now(), 10 * 60_000));
    }
    return this.backoffMs(attempt);
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** attempt, 60_000);
    return base + Math.floor(Math.random() * 250);
  }

  private async safeJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }
}
