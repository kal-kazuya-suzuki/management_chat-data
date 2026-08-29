/**
 * 期間を指定したメッセージ取得（ページング）。
 *
 * ■ 前提: Chatwork API の制約
 * GET /rooms/{room_id}/messages は 1回あたり最大100件しか返さず、公式には
 * offset / before / limit のようなページングパラメータが存在しない。
 * 実運用では未公開の `message_id` パラメータで続きのページを辿れることが知られているため、
 * ここではそれを使いつつ、「実際に古い方向へ進めているか」を毎ページ検証する。
 * 進めていないと分かった時点で打ち切り、warnings で呼び出し元に伝える
 * （黙って期間の一部だけを出力してしまうのが一番まずいため）。
 */
import type { ChatworkMessage } from './types.js';

export interface MessageSource {
  getMessages(roomId: string, options?: { messageId?: string; force?: boolean }): Promise<ChatworkMessage[] | null>;
}

export interface PageProgress {
  page: number;
  received: number;
  total: number;
  /** 現時点で確認できている最古メッセージの send_time（UNIX秒）。未取得なら null */
  oldestSendTime: number | null;
}

export interface FetchRangeOptions {
  roomId: string;
  /** 期間の開始（UNIX秒・以上） */
  fromEpoch: number;
  /** 期間の終了（UNIX秒・以下） */
  toEpoch: number;
  /** 安全弁。既定 200ページ（＝最大2万件） */
  maxPages?: number;
  /** 1ページの最大件数。これ未満しか返らなければ履歴の先頭に到達したとみなす。既定 100 */
  pageSize?: number;
  onProgress?: (progress: PageProgress) => void;
}

export interface FetchRangeResult {
  /** 期間内のメッセージ（send_time 昇順、message_id で安定ソート） */
  messages: ChatworkMessage[];
  /** 取得した全メッセージ件数（期間外を含む） */
  fetchedCount: number;
  /** 実行した API リクエスト（ページ）数 */
  pages: number;
  /** 期間の開始まで遡れたか（false なら取りこぼしの可能性がある） */
  coveredFrom: boolean;
  /** 打ち切りや API 制約についての警告 */
  warnings: string[];
}

export const DEFAULT_MAX_PAGES = 200;
/** Chatwork API が1回に返す最大件数 */
export const PAGE_SIZE = 100;

/** send_time 昇順（同時刻は message_id で安定化）。 */
function byTimeAsc(a: ChatworkMessage, b: ChatworkMessage): number {
  if (a.send_time !== b.send_time) return a.send_time - b.send_time;
  return compareMessageId(a.message_id, b.message_id);
}

/** message_id は桁数の異なる数値文字列なので、桁数 → 辞書順で比較する。 */
export function compareMessageId(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    if (a.length !== b.length) return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function fetchMessagesInRange(
  source: MessageSource,
  options: FetchRangeOptions,
): Promise<FetchRangeResult> {
  const { roomId, fromEpoch, toEpoch } = options;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const warnings: string[] = [];
  const collected = new Map<string, ChatworkMessage>();

  let cursor: string | undefined;
  let pages = 0;
  let coveredFrom = false;
  let oldestSendTime: number | null = null;
  let oldestMessageId: string | undefined;

  while (pages < maxPages) {
    const batch = await source.getMessages(roomId, cursor ? { messageId: cursor } : {});
    pages += 1;

    if (!batch || batch.length === 0) {
      // これ以上遡れない = ルームの先頭まで到達した
      coveredFrom = true;
      options.onProgress?.({ page: pages, received: 0, total: collected.size, oldestSendTime });
      break;
    }

    let added = 0;
    for (const message of batch) {
      if (!collected.has(message.message_id)) added += 1;
      collected.set(message.message_id, message);
    }

    const previousOldest = oldestSendTime;
    for (const message of batch) {
      if (oldestSendTime === null || message.send_time < oldestSendTime) {
        oldestSendTime = message.send_time;
        oldestMessageId = message.message_id;
      } else if (
        message.send_time === oldestSendTime &&
        oldestMessageId !== undefined &&
        compareMessageId(message.message_id, oldestMessageId) < 0
      ) {
        oldestMessageId = message.message_id;
      }
    }

    options.onProgress?.({ page: pages, received: batch.length, total: collected.size, oldestSendTime });

    if (added === 0) {
      // 同じページが返り続けている。これ以上進めないので打ち切る。
      coveredFrom = oldestSendTime !== null && oldestSendTime <= fromEpoch;
      if (!coveredFrom) {
        warnings.push(
          'これ以上古いメッセージを取得できませんでした（同じページが返却されました）。指定期間の全体をカバーできていない可能性があります。',
        );
      }
      break;
    }

    if (cursor !== undefined && previousOldest !== null && oldestSendTime !== null && oldestSendTime >= previousOldest) {
      // message_id を指定しても古い方向に進まなかった＝この API では過去を遡れない
      warnings.push(
        'API が過去方向のページングに応答しませんでした（未公開パラメータ message_id が使えない可能性）。取得できたのは直近のメッセージのみです。',
      );
      break;
    }

    if (oldestSendTime !== null && oldestSendTime <= fromEpoch) {
      coveredFrom = true;
      break;
    }

    if (batch.length < pageSize) {
      // 上限に満たない = これ以上古いメッセージは無い（無駄なリクエストを1回節約する）
      coveredFrom = true;
      break;
    }

    cursor = oldestMessageId;
  }

  if (pages >= maxPages && !coveredFrom) {
    warnings.push(`最大ページ数（${maxPages}）に達したため取得を打ち切りました。--max-pages で調整できます。`);
  }

  const messages = [...collected.values()]
    .filter((message) => message.send_time >= fromEpoch && message.send_time <= toEpoch)
    .sort(byTimeAsc);

  return {
    messages,
    fetchedCount: collected.size,
    pages,
    coveredFrom,
    warnings,
  };
}
