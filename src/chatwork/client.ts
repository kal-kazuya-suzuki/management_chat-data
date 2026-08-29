/**
 * Chatwork API クライアント。
 *
 * - レート制限（既定 300回 / 5分）を守る
 * - 429 は Retry-After / x-ratelimit-reset を見て待機し、再試行する
 * - 5xx とネットワークエラーは指数バックオフ（ジッタ付き）で再試行する
 *
 * fetch と sleep を差し替えられるようにしてテスト可能にしてある。
 */
import { RateLimiter, defaultSleep } from '../util/rate-limiter.js';
import * as log from '../util/log.js';
import type { ChatworkMe, ChatworkMember, ChatworkMessage, ChatworkRoom } from './types.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>;

export interface ChatworkClientOptions {
  token: string;
  baseUrl?: string;
  rateLimit?: number;
  rateWindowSeconds?: number;
  minIntervalMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ChatworkApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'ChatworkApiError';
  }
}

/** リトライしても意味がないステータス（認証・権限・不正リクエスト） */
const NON_RETRYABLE = new Set([400, 401, 403, 404]);

export class ChatworkClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private requestCount = 0;

  constructor(options: ChatworkClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.chatwork.com/v2').replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.limiter = new RateLimiter({
      limit: options.rateLimit ?? 300,
      windowSeconds: options.rateWindowSeconds ?? 300,
      minIntervalMs: options.minIntervalMs ?? 0,
      sleep: this.sleep,
      now: options.now,
      onWait: (waitMs, reason) => {
        if (waitMs >= 1000) log.step(`${reason}のため ${Math.ceil(waitMs / 1000)} 秒待機します`);
        else log.debug(`${reason}のため ${waitMs}ms 待機`);
      },
    });
  }

  /** これまでに実際に送った HTTP リクエスト数（リトライ含む）。 */
  get totalRequests(): number {
    return this.requestCount;
  }

  async getMe(): Promise<ChatworkMe> {
    const result = await this.request<ChatworkMe>('/me');
    if (!result) throw new ChatworkApiError('GET /me が空のレスポンスを返しました', 204, '');
    return result;
  }

  async getRooms(): Promise<ChatworkRoom[]> {
    return (await this.request<ChatworkRoom[]>('/rooms')) ?? [];
  }

  async getRoom(roomId: string): Promise<ChatworkRoom | null> {
    return await this.request<ChatworkRoom>(`/rooms/${encodeURIComponent(roomId)}`);
  }

  async getRoomMembers(roomId: string): Promise<ChatworkMember[]> {
    return (await this.request<ChatworkMember[]>(`/rooms/${encodeURIComponent(roomId)}/members`)) ?? [];
  }

  /**
   * ルームのメッセージを取得する（最大100件）。
   *
   * force=1 は「未読状態に関係なく最新から最大100件」を返す。
   * messageId を渡すと、その message_id を起点とした続きのページを返す（公式ドキュメント
   * には無いパラメータ。詳細と限界は README の「取得の制約」を参照）。
   *
   * 該当メッセージが無い場合、Chatwork は 204 No Content を返す → null。
   */
  async getMessages(roomId: string, options: { messageId?: string; force?: boolean } = {}): Promise<ChatworkMessage[] | null> {
    const query: Record<string, string> = { force: options.force === false ? '0' : '1' };
    if (options.messageId) query.message_id = options.messageId;
    return await this.request<ChatworkMessage[]>(`/rooms/${encodeURIComponent(roomId)}/messages`, query);
  }

  /** GET リクエスト本体。204 の場合は null を返す。 */
  private async request<T>(path: string, query: Record<string, string> = {}): Promise<T | null> {
    const search = new URLSearchParams(query).toString();
    const url = `${this.baseUrl}${path}${search ? `?${search}` : ''}`;

    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      this.requestCount += 1;
      log.debug(`GET ${url} (試行 ${attempt + 1})`);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'X-ChatWorkToken': this.token,
            Accept: 'application/json',
          },
        });
      } catch (cause) {
        if (attempt >= this.maxRetries) {
          throw new Error(`通信に失敗しました: ${path} (${String(cause)})`);
        }
        const waitMs = this.backoffMs(attempt);
        log.warn(`通信エラー。${Math.ceil(waitMs / 1000)} 秒後に再試行します (${String(cause)})`);
        // 待機はすべてレートリミッタ経由（次の acquire() で消化される）
        this.limiter.pauseFor(waitMs);
        attempt += 1;
        continue;
      }

      this.limiter.applyHeaders(
        readIntHeader(response, 'x-ratelimit-remaining'),
        readIntHeader(response, 'x-ratelimit-reset'),
      );

      if (response.status === 204) return null;

      if (response.ok) {
        const text = await response.text();
        if (!text.trim()) return null;
        return JSON.parse(text) as T;
      }

      const body = await safeText(response);

      if (response.status === 429) {
        const waitMs = this.rateLimitWaitMs(response, attempt);
        if (attempt >= this.maxRetries) {
          throw new ChatworkApiError(
            `レート制限（429）が解消しませんでした: ${path}`,
            429,
            body,
          );
        }
        this.limiter.pauseFor(waitMs);
        log.warn(`レート制限(429)。${Math.ceil(waitMs / 1000)} 秒待機して再試行します`);
        attempt += 1;
        continue;
      }

      if (NON_RETRYABLE.has(response.status) || attempt >= this.maxRetries) {
        throw new ChatworkApiError(
          `Chatwork API エラー ${response.status} ${response.statusText}: ${path}\n${body}`,
          response.status,
          body,
        );
      }

      const waitMs = this.backoffMs(attempt);
      log.warn(`HTTP ${response.status}。${Math.ceil(waitMs / 1000)} 秒後に再試行します`);
      this.limiter.pauseFor(waitMs);
      attempt += 1;
    }
  }

  /** 429 の待機時間: Retry-After → x-ratelimit-reset → 指数バックオフ の優先順。 */
  private rateLimitWaitMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10 * 60_000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, Math.min(date - this.now(), 10 * 60_000));
    }
    const reset = readIntHeader(response, 'x-ratelimit-reset');
    if (reset !== null) {
      const waitMs = reset * 1000 - this.now();
      if (waitMs > 0) return Math.min(waitMs + 1000, 10 * 60_000);
    }
    return this.backoffMs(attempt);
  }

  /** 指数バックオフ + ジッタ（1s, 2s, 4s, ... 上限60s）。 */
  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** attempt, 60_000);
    return base + Math.floor(Math.random() * 250);
  }
}

function readIntHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return '';
  }
}
