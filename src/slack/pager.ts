/**
 * 期間を指定したメッセージ取得（カーソルページング）。
 *
 * Chatwork と違い、Slack は `oldest` / `latest` で期間を指定でき、
 * `response_metadata.next_cursor` による正式なページングがあるため、期間の取りこぼしは起きない。
 *
 * ただし2点、構造上の注意がある。
 *   1. `conversations.history` は **スレッドの親（トップレベル）しか返さない**。
 *      返信を含めるには、スレッドごとに `conversations.replies` を呼ぶ必要がある。
 *   2. 期間より前に始まったスレッドへの、期間内の返信は取得できない。
 *      history が親を返さないため、そのスレッドの存在自体が分からないため。
 *      該当し得る場合は警告を出す。
 */
import type { SlackMessage } from './types.js';

export interface SlackMessageSource {
  getHistoryPage(params: {
    channel: string;
    oldest: string;
    latest: string;
    limit: number;
    cursor?: string;
  }): Promise<{ messages: SlackMessage[]; nextCursor: string | undefined; hasMore: boolean }>;
  getThreadReplies(channel: string, threadTs: string, limit?: number): Promise<SlackMessage[]>;
}

export interface SlackPageProgress {
  page: number;
  received: number;
  total: number;
  /** 現時点で確認できている最古メッセージの送信時刻（UNIX秒）。未取得なら null */
  oldestTs: number | null;
  phase: 'history' | 'threads';
  /** phase='threads' のときの進捗 */
  threadsDone?: number;
  threadsTotal?: number;
}

export interface FetchChannelOptions {
  channelId: string;
  /** 期間の開始（UNIX秒・以上） */
  fromEpoch: number;
  /** 期間の終了（UNIX秒・以下） */
  toEpoch: number;
  /** 1ページの要求件数。既定 200（Slack の推奨上限） */
  pageLimit?: number;
  /** スレッドの返信も取得するか。既定 true */
  includeThreads?: boolean;
  /** 安全弁。既定 500ページ */
  maxPages?: number;
  /** 返信を取りに行くスレッド数の上限。既定 1000 */
  maxThreads?: number;
  onProgress?: (progress: SlackPageProgress) => void;
}

export interface FetchChannelResult {
  /** 期間内のメッセージ（送信時刻の昇順、ts で安定ソート） */
  messages: SlackMessage[];
  fetchedCount: number;
  /** conversations.history のページ数 */
  pages: number;
  /** 返信を取得したスレッド数 */
  threadsFetched: number;
  /** 実際に取りこぼしが起きた・起きた可能性がある事象 */
  warnings: string[];
  /** 仕様上の注意（毎回同じ内容になるもの）。警告と混ぜると警告が読み飛ばされるので分ける */
  notes: string[];
}

export const DEFAULT_PAGE_LIMIT = 200;
export const DEFAULT_MAX_PAGES = 500;
export const DEFAULT_MAX_THREADS = 1000;

/**
 * Marketplace 未掲載の配布アプリに課される上限（1回15件）。
 * これに当たると全期間の取得が現実的でないため、検知して警告する。
 */
const RESTRICTED_PAGE_SIZE = 15;

/** ts（"1756400000.123456"）を UNIX 秒（小数含む）にする。 */
export function tsToEpoch(ts: string): number {
  const value = Number.parseFloat(ts);
  return Number.isFinite(value) ? value : 0;
}

/** ts の昇順で比較する。文字列比較ではなく数値として比較する。 */
export function compareTs(a: string, b: string): number {
  const diff = tsToEpoch(a) - tsToEpoch(b);
  if (diff !== 0) return diff;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** スレッドの親メッセージ（返信を持つもの）か。 */
export function isThreadParent(message: SlackMessage): boolean {
  return (
    typeof message.thread_ts === 'string' &&
    message.thread_ts === message.ts &&
    (message.reply_count ?? 0) > 0
  );
}

export async function fetchChannelMessages(
  source: SlackMessageSource,
  options: FetchChannelOptions,
): Promise<FetchChannelResult> {
  const { channelId, fromEpoch, toEpoch } = options;
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const includeThreads = options.includeThreads !== false;

  const warnings: string[] = [];
  const notes: string[] = [];
  const collected = new Map<string, SlackMessage>();

  let cursor: string | undefined;
  let pages = 0;
  let truncated = false;
  let largestPage = 0;
  let sawMultiplePages = false;

  // --- 1. トップレベルのメッセージを期間分ページングする ---
  for (;;) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }

    const page = await source.getHistoryPage({
      channel: channelId,
      oldest: String(fromEpoch),
      latest: String(toEpoch),
      limit: pageLimit,
      ...(cursor ? { cursor } : {}),
    });
    pages += 1;
    largestPage = Math.max(largestPage, page.messages.length);

    for (const message of page.messages) {
      collected.set(message.ts, message);
    }

    options.onProgress?.({
      page: pages,
      received: page.messages.length,
      total: collected.size,
      oldestTs: oldestEpochOf(collected),
      phase: 'history',
    });

    if (!page.nextCursor) break;
    sawMultiplePages = true;
    cursor = page.nextCursor;
  }

  if (truncated) {
    warnings.push(
      `最大ページ数（${maxPages}）に達したため取得を打ち切りました。--max-pages で調整できます。`,
    );
  }

  // 15件上限（Marketplace 未掲載の配布アプリ向けの制限）に当たっていないか
  if (sawMultiplePages && pageLimit > RESTRICTED_PAGE_SIZE && largestPage <= RESTRICTED_PAGE_SIZE) {
    warnings.push(
      `1回のリクエストで ${largestPage} 件しか返っていません（${pageLimit} 件を要求）。` +
        'Marketplace 未掲載の配布アプリに課される制限（1分1リクエスト・1回15件）に当たっている可能性があります。' +
        'ワークスペース内製アプリのトークンを使うと解消します（README「レート制限」を参照）。',
    );
  }

  // --- 2. スレッドの返信を取得する ---
  let threadsFetched = 0;
  if (includeThreads) {
    const parents = [...collected.values()].filter(isThreadParent);
    const targets = parents.slice(0, maxThreads);

    if (parents.length > targets.length) {
      warnings.push(
        `返信を取得するスレッド数が上限（${maxThreads}）を超えました。${parents.length - targets.length} 件のスレッドの返信は取得していません。--max-threads で調整できます。`,
      );
    }

    for (const [index, parent] of targets.entries()) {
      const replies = await source.getThreadReplies(channelId, parent.ts);
      threadsFetched += 1;

      for (const reply of replies) {
        // 親は既に持っている。期間の終わりより後の返信は範囲外なので除く
        if (tsToEpoch(reply.ts) > toEpoch) continue;
        collected.set(reply.ts, reply);
      }

      options.onProgress?.({
        page: pages,
        received: replies.length,
        total: collected.size,
        oldestTs: oldestEpochOf(collected),
        phase: 'threads',
        threadsDone: index + 1,
        threadsTotal: targets.length,
      });
    }

    if (targets.length > 0) {
      notes.push(
        '期間の開始より前に始まったスレッドへの返信は取得できません' +
          '（conversations.history が期間外の親メッセージを返さないため）。' +
          '古いスレッドの返信も必要な場合は --from を早めてください。',
      );
    }
  }

  const messages = [...collected.values()]
    .filter((message) => {
      const epoch = tsToEpoch(message.ts);
      return epoch >= fromEpoch && epoch <= toEpoch;
    })
    .sort((a, b) => compareTs(a.ts, b.ts));

  return {
    messages,
    fetchedCount: collected.size,
    pages,
    threadsFetched,
    warnings,
    notes,
  };
}

function oldestEpochOf(collected: Map<string, SlackMessage>): number | null {
  let oldest: number | null = null;
  for (const message of collected.values()) {
    const epoch = tsToEpoch(message.ts);
    if (oldest === null || epoch < oldest) oldest = epoch;
  }
  return oldest;
}
