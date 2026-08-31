/**
 * 期間を指定したメール取得。
 *
 * 手順:
 *   1. `users.messages.list` に検索クエリを渡し、`nextPageToken` を辿って
 *      「自分が送信したメール」を期間分すべて拾う
 *   2. その threadId を重複排除する
 *   3. スレッドごとに `users.threads.get` を呼び、相手のメールも含めた
 *      やり取り全体を取得する
 *
 * Chatwork と違って正式なページングがあるので、期間の取りこぼしは起きない。
 * 「期間」は *自分が送信したメールの日付* で判定し、該当したスレッドは全体を取得する
 * （やり取りの文脈が切れないようにするため。期間外の相手のメールも含まれる）。
 */
import type { GmailThread } from './types.js';

export interface GmailMessageSource {
  listMessagePage(params: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<{ messages: Array<{ id: string; threadId: string }>; nextPageToken: string | undefined }>;
  getThread(threadId: string): Promise<GmailThread>;
}

export interface GmailProgress {
  phase: 'list' | 'threads';
  page: number;
  /** 見つかったメッセージ数（list 中）またはスレッド取得数（threads 中） */
  found: number;
  threadsDone?: number;
  threadsTotal?: number;
}

export interface FetchThreadsOptions {
  /** 期間の開始（UNIX秒・以上） */
  fromEpoch: number;
  /** 期間の終了（UNIX秒・以下） */
  toEpoch: number;
  /** 自分が送信したものだけを起点にする。既定 true */
  onlySent?: boolean;
  /** 追加の Gmail 検索クエリ（例: "from:example.com"） */
  extraQuery?: string;
  /** 1ページの取得件数。既定 500（Gmail の上限） */
  pageSize?: number;
  /** 安全弁。既定 100ページ */
  maxPages?: number;
  /** 取得するスレッド数の上限。既定 2000 */
  maxThreads?: number;
  onProgress?: (progress: GmailProgress) => void;
}

export interface FetchThreadsResult {
  threads: GmailThread[];
  /** 検索に一致したメッセージ数（スレッド展開前） */
  matchedMessages: number;
  pages: number;
  /** 実際に組み立てた検索クエリ（デバッグと README 用） */
  query: string;
  warnings: string[];
  notes: string[];
}

export const DEFAULT_PAGE_SIZE = 500;
export const DEFAULT_MAX_PAGES = 100;
export const DEFAULT_MAX_THREADS = 2000;

/**
 * Gmail の検索クエリを組み立てる。
 * 日付は `after:`/`before:` に UNIX 秒を渡す（YYYY/MM/DD 形式だとタイムゾーンの解釈が
 * Gmail の設定に依存してしまうため）。
 * `before:` は「その値より前」なので、指定日の 23:59:59 を含めるために +1 する。
 */
export function buildGmailQuery(options: {
  fromEpoch: number;
  toEpoch: number;
  onlySent?: boolean;
  extraQuery?: string;
}): string {
  const parts: string[] = [];
  if (options.onlySent !== false) parts.push('from:me');
  parts.push(`after:${Math.floor(options.fromEpoch)}`);
  parts.push(`before:${Math.floor(options.toEpoch) + 1}`);
  const extra = options.extraQuery?.trim();
  if (extra) parts.push(extra);
  return parts.join(' ');
}

export async function fetchThreadsInRange(
  source: GmailMessageSource,
  options: FetchThreadsOptions,
): Promise<FetchThreadsResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const maxThreads = options.maxThreads ?? DEFAULT_MAX_THREADS;
  const warnings: string[] = [];
  const notes: string[] = [];

  const query = buildGmailQuery({
    fromEpoch: options.fromEpoch,
    toEpoch: options.toEpoch,
    onlySent: options.onlySent,
    extraQuery: options.extraQuery,
  });

  // --- 1. 条件に合うメッセージを列挙して threadId を集める ---
  const threadIds: string[] = [];
  const seenThreads = new Set<string>();
  let matchedMessages = 0;
  let pages = 0;
  let pageToken: string | undefined;
  let truncatedPages = false;

  for (;;) {
    if (pages >= maxPages) {
      truncatedPages = true;
      break;
    }

    const page = await source.listMessagePage({
      query,
      maxResults: pageSize,
      ...(pageToken ? { pageToken } : {}),
    });
    pages += 1;
    matchedMessages += page.messages.length;

    for (const ref of page.messages) {
      if (seenThreads.has(ref.threadId)) continue;
      seenThreads.add(ref.threadId);
      threadIds.push(ref.threadId);
    }

    options.onProgress?.({ phase: 'list', page: pages, found: matchedMessages });

    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  if (truncatedPages) {
    warnings.push(
      `最大ページ数（${maxPages}）に達したため列挙を打ち切りました。--max-pages で調整できます。`,
    );
  }

  // --- 2. スレッド本体を取得する ---
  const targets = threadIds.slice(0, maxThreads);
  if (threadIds.length > targets.length) {
    warnings.push(
      `スレッド数が上限（${maxThreads}）を超えました。${threadIds.length - targets.length} 件のスレッドは取得していません。--max-threads で調整できます。`,
    );
  }

  const threads: GmailThread[] = [];
  for (const [index, threadId] of targets.entries()) {
    threads.push(await source.getThread(threadId));
    options.onProgress?.({
      phase: 'threads',
      page: pages,
      found: threads.length,
      threadsDone: index + 1,
      threadsTotal: targets.length,
    });
  }

  if (targets.length > 0) {
    notes.push(
      '期間は「自分が送信したメールの日付」で判定しています。' +
        '該当したスレッドは全体を取得するため、期間より前の相手のメールも文脈として含まれます。',
    );
  }

  return { threads, matchedMessages, pages, query, warnings, notes };
}
