/**
 * Slack Web API クライアント。
 *
 * - Slack は HTTP 200 で `{"ok": false, "error": "..."}` を返すので、本文を見てエラー判定する
 * - 429 は `Retry-After` ヘッダ（秒）を必ず返すので、それに従って待機・再試行する
 * - カーソルページング（`response_metadata.next_cursor`）に対応する
 *
 * レート制限について（README にも記載）:
 *   ワークスペース内製アプリ（内部アプリ）は従来どおり 50+ req/分・1回1000件まで。
 *   Marketplace 未掲載の配布アプリは 2026-03-03 以降 `conversations.history` /
 *   `conversations.replies` が **1 req/分・1回15件** に制限される。
 *   後者に当たると全期間の取得は現実的でないため、検知して警告する。
 */
import { RateLimiter, defaultSleep } from '../util/rate-limiter.js';
import * as log from '../util/log.js';
import type {
  SlackAuthTest,
  SlackChannel,
  SlackConversationsListResponse,
  SlackHistoryResponse,
  SlackMessage,
  SlackUser,
  SlackUsersListResponse,
} from './types.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<Response>;

export interface SlackClientOptions {
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

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly slackError: string,
    readonly method: string,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/** 再試行しても解消しない Slack エラー（権限・引数の誤り）。 */
const NON_RETRYABLE_ERRORS = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'missing_scope',
  'not_allowed_token_type',
  'channel_not_found',
  'thread_not_found',
  'not_in_channel',
  'is_archived',
  'invalid_arguments',
  'invalid_cursor',
  'invalid_ts_latest',
  'invalid_ts_oldest',
]);

/** エラーコードごとの対処法。そのまま出しても分かりにくいので補足する。 */
const ERROR_HINTS: Record<string, string> = {
  invalid_auth: 'トークンが無効です。SLACK_TOKEN を確認してください。',
  not_authed: 'トークンが設定されていません。',
  missing_scope: 'トークンに必要な権限（スコープ）がありません。README のスコープ一覧を確認してください。',
  not_in_channel:
    'Bot がそのチャンネルに参加していません。チャンネルで /invite するか、ユーザートークン（xoxp-）を使ってください。',
  channel_not_found:
    'チャンネルが見つかりません。ID が正しいか、Bot から見えるチャンネルかを確認してください（`npm run channels` で一覧できます）。',
  ratelimited: 'レート制限に達しました。',
};

export class SlackClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private requestCount = 0;
  /** 429 を受けた回数（レート制限の厳しさを利用者に伝えるため） */
  private rateLimitHits = 0;

  constructor(options: SlackClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.limiter = new RateLimiter({
      limit: options.rateLimit ?? 50,
      windowSeconds: options.rateWindowSeconds ?? 60,
      minIntervalMs: options.minIntervalMs ?? 0,
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

  async authTest(): Promise<SlackAuthTest> {
    return await this.call<SlackAuthTest>('auth.test');
  }

  /** チャンネル一覧（カーソルを辿って全件）。 */
  async listChannels(options: { types?: string; excludeArchived?: boolean } = {}): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<SlackConversationsListResponse>('conversations.list', {
        types: options.types ?? 'public_channel,private_channel',
        exclude_archived: options.excludeArchived === false ? 'false' : 'true',
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      channels.push(...(response.channels ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  }

  async getChannelInfo(channelId: string): Promise<SlackChannel | null> {
    const response = await this.call<{ ok: boolean; channel?: SlackChannel }>('conversations.info', {
      channel: channelId,
    });
    return response.channel ?? null;
  }

  /** ワークスペースのユーザー一覧（カーソルを辿って全件）。 */
  async listUsers(): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<SlackUsersListResponse>('users.list', {
        limit: '200',
        ...(cursor ? { cursor } : {}),
      });
      users.push(...(response.members ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return users;
  }

  /** conversations.history の1ページ。 */
  async getHistoryPage(params: {
    channel: string;
    oldest: string;
    latest: string;
    limit: number;
    cursor?: string;
  }): Promise<{ messages: SlackMessage[]; nextCursor: string | undefined; hasMore: boolean }> {
    const response = await this.call<SlackHistoryResponse>('conversations.history', {
      channel: params.channel,
      oldest: params.oldest,
      latest: params.latest,
      inclusive: 'true',
      limit: String(params.limit),
      ...(params.cursor ? { cursor: params.cursor } : {}),
    });
    return {
      messages: response.messages ?? [],
      nextCursor: response.response_metadata?.next_cursor || undefined,
      hasMore: response.has_more === true,
    };
  }

  /** スレッドの返信（親メッセージを含む）。カーソルを辿って全件。 */
  async getThreadReplies(channel: string, threadTs: string, limit = 200): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.call<SlackHistoryResponse>('conversations.replies', {
        channel,
        ts: threadTs,
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...(response.messages ?? []));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return messages;
  }

  /** Web API 呼び出し本体。Slack は 200 でも ok:false を返すので本文で判定する。 */
  private async call<T>(method: string, params: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/${method}${search ? `?${search}` : ''}`;

    let attempt = 0;
    for (;;) {
      await this.limiter.acquire();
      this.requestCount += 1;
      log.debug(`GET ${method} (試行 ${attempt + 1})`);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
          },
        });
      } catch (cause) {
        if (attempt >= this.maxRetries) {
          throw new Error(`通信に失敗しました: ${method} (${String(cause)})`);
        }
        const waitMs = this.backoffMs(attempt);
        log.warn(`通信エラー。${Math.ceil(waitMs / 1000)} 秒後に再試行します (${String(cause)})`);
        this.limiter.pauseFor(waitMs);
        attempt += 1;
        continue;
      }

      if (response.status === 429) {
        this.rateLimitHits += 1;
        const waitMs = this.retryAfterMs(response, attempt);
        if (attempt >= this.maxRetries) {
          throw new SlackApiError(
            `レート制限（429）が解消しませんでした: ${method}`,
            'ratelimited',
            method,
          );
        }
        this.limiter.pauseFor(waitMs);
        log.warn(`レート制限(429)。${Math.ceil(waitMs / 1000)} 秒待機して再試行します`);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        // 5xx などは再試行する
        if (attempt >= this.maxRetries) {
          throw new SlackApiError(
            `Slack API エラー HTTP ${response.status}: ${method}`,
            `http_${response.status}`,
            method,
          );
        }
        const waitMs = this.backoffMs(attempt);
        log.warn(`HTTP ${response.status}。${Math.ceil(waitMs / 1000)} 秒後に再試行します`);
        this.limiter.pauseFor(waitMs);
        attempt += 1;
        continue;
      }

      const body = (await response.json()) as T & {
        ok: boolean;
        error?: string;
        warning?: string;
        needed?: string;
      };

      if (body.ok) {
        if (body.warning) log.debug(`${method}: warning=${body.warning}`);
        return body;
      }

      const slackError = body.error ?? 'unknown_error';

      // ok:false でも ratelimited は待って再試行する
      if (slackError === 'ratelimited' && attempt < this.maxRetries) {
        this.rateLimitHits += 1;
        const waitMs = this.retryAfterMs(response, attempt);
        this.limiter.pauseFor(waitMs);
        log.warn(`レート制限。${Math.ceil(waitMs / 1000)} 秒待機して再試行します`);
        attempt += 1;
        continue;
      }

      if (NON_RETRYABLE_ERRORS.has(slackError) || attempt >= this.maxRetries) {
        const hint = ERROR_HINTS[slackError];
        const needed = body.needed ? `\n  必要なスコープ: ${body.needed}` : '';
        throw new SlackApiError(
          `Slack API エラー: ${method} → ${slackError}${hint ? `\n  ${hint}` : ''}${needed}`,
          slackError,
          method,
        );
      }

      const waitMs = this.backoffMs(attempt);
      log.warn(`${method} が ${slackError} を返しました。${Math.ceil(waitMs / 1000)} 秒後に再試行します`);
      this.limiter.pauseFor(waitMs);
      attempt += 1;
    }
  }

  /** Slack は 429 で必ず Retry-After（秒）を返す。 */
  private retryAfterMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000 + 500, 15 * 60_000);
      }
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(0, Math.min(date - this.now(), 15 * 60_000));
    }
    return this.backoffMs(attempt);
  }

  /** 指数バックオフ + ジッタ（1s, 2s, 4s, ... 上限60s）。 */
  private backoffMs(attempt: number): number {
    const base = Math.min(1000 * 2 ** attempt, 60_000);
    return base + Math.floor(Math.random() * 250);
  }
}
