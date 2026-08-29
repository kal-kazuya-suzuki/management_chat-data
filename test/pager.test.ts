import { describe, expect, it } from 'vitest';
import {
  compareMessageId,
  fetchMessagesInRange,
  type MessageSource,
} from '../src/chatwork/pager.js';
import type { ChatworkMessage } from '../src/chatwork/types.js';

const DAY = 86_400;
/** 2026-08-29 00:00:00 UTC */
const BASE = 1_787_961_600;

function message(index: number, sendTime: number): ChatworkMessage {
  return {
    message_id: String(1_000_000_000 + index),
    account: { account_id: 1111, name: 'テスト太郎' },
    body: `本文 ${index}`,
    send_time: sendTime,
    update_time: 0,
  };
}

/**
 * Chatwork API を模したフェイク。
 * message_id 未指定なら最新100件、指定ありならその message_id より古い100件を返す。
 */
class FakeChatwork implements MessageSource {
  readonly calls: Array<string | undefined> = [];

  /** 新しい順に並んだ全メッセージ */
  constructor(
    private readonly all: ChatworkMessage[],
    private readonly pageSize = 100,
  ) {}

  async getMessages(
    _roomId: string,
    options: { messageId?: string } = {},
  ): Promise<ChatworkMessage[] | null> {
    this.calls.push(options.messageId);

    const sorted = [...this.all].sort((a, b) => a.send_time - b.send_time);
    let pool = sorted;
    if (options.messageId) {
      const index = sorted.findIndex((m) => m.message_id === options.messageId);
      if (index <= 0) return null;
      pool = sorted.slice(0, index);
    }
    if (pool.length === 0) return null;
    // 「新しい方から pageSize 件」を古い順に返す
    return pool.slice(Math.max(0, pool.length - this.pageSize));
  }
}

describe('fetchMessagesInRange', () => {
  it('1ページで収まる場合は1リクエストで終わる', async () => {
    const messages = Array.from({ length: 10 }, (_, i) => message(i, BASE + i * 60));
    const api = new FakeChatwork(messages);

    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE + DAY,
    });

    expect(api.calls).toEqual([undefined]);
    expect(result.messages).toHaveLength(10);
    expect(result.pages).toBe(1);
  });

  it('100件を超える履歴をページングして取り切る', async () => {
    // 250件、1分間隔
    const messages = Array.from({ length: 250 }, (_, i) => message(i, BASE + i * 60));
    const api = new FakeChatwork(messages);

    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE + DAY,
    });

    expect(result.messages).toHaveLength(250);
    expect(result.pages).toBeGreaterThanOrEqual(3);
    expect(result.coveredFrom).toBe(true);
    expect(result.warnings).toEqual([]);
    // 2ページ目以降はカーソル付きで呼ばれている
    expect(api.calls[0]).toBeUndefined();
    expect(api.calls[1]).toBeDefined();
  });

  it('期間の開始まで遡ったらそこで打ち切る（不要なページを取りに行かない）', async () => {
    // 500件を1時間間隔で並べる（＝およそ20日分）
    const messages = Array.from({ length: 500 }, (_, i) => message(i, BASE - (500 - i) * 3600));
    const api = new FakeChatwork(messages);

    // 直近2日ぶんだけ欲しい
    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - 2 * DAY,
      toEpoch: BASE,
    });

    expect(result.coveredFrom).toBe(true);
    expect(result.pages).toBeLessThan(5);
    // 期間内（48時間ぶん）のメッセージだけが残る
    expect(result.messages.every((m) => m.send_time >= BASE - 2 * DAY)).toBe(true);
    expect(result.messages).toHaveLength(48);
  });

  it('期間外のメッセージは結果から除外される', async () => {
    const messages = [
      message(0, BASE - 10 * DAY), // 期間より前
      message(1, BASE - 1 * DAY), // 期間内
      message(2, BASE + 1 * DAY), // 期間内
      message(3, BASE + 10 * DAY), // 期間より後
    ];
    const api = new FakeChatwork(messages);

    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - 2 * DAY,
      toEpoch: BASE + 2 * DAY,
    });

    expect(result.messages.map((m) => m.message_id)).toEqual(['1000000001', '1000000002']);
    expect(result.fetchedCount).toBe(4);
  });

  it('結果は send_time 昇順に並ぶ', async () => {
    const messages = [message(0, BASE + 300), message(1, BASE + 100), message(2, BASE + 200)];
    const api = new FakeChatwork(messages);

    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
    });

    expect(result.messages.map((m) => m.send_time)).toEqual([BASE + 100, BASE + 200, BASE + 300]);
  });

  it('重複して返ってきたメッセージは1件にまとめる', async () => {
    const duplicating: MessageSource = {
      calls: 0,
      async getMessages() {
        // 毎回同じ2件を返す（＝これ以上遡れない）
        return [message(0, BASE), message(1, BASE + 60)];
      },
    } as MessageSource & { calls: number };

    const result = await fetchMessagesInRange(duplicating, {
      roomId: '1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE + DAY,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.pages).toBe(1);
  });

  it('204 No Content（null）で履歴の先頭に到達したと判断する', async () => {
    let call = 0;
    const source: MessageSource = {
      async getMessages() {
        call += 1;
        if (call === 1) return Array.from({ length: 100 }, (_, i) => message(i, BASE - i * 60));
        return null;
      },
    };

    const result = await fetchMessagesInRange(source, {
      roomId: '1',
      fromEpoch: 0,
      toEpoch: BASE + DAY,
    });

    expect(result.coveredFrom).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.messages).toHaveLength(100);
  });

  it('過去方向に進まない API では警告を出して打ち切る', async () => {
    // message_id を渡しても「もっと新しい側」を返してくる実装を模す
    let call = 0;
    const source: MessageSource = {
      async getMessages() {
        call += 1;
        if (call === 1) {
          return Array.from({ length: 100 }, (_, i) => message(i, BASE - (100 - i) * 60));
        }
        // 2回目: すべて1回目より新しいメッセージ
        return Array.from({ length: 100 }, (_, i) => message(200 + i, BASE + i * 60));
      },
    };

    const result = await fetchMessagesInRange(source, {
      roomId: '1',
      fromEpoch: BASE - 365 * DAY,
      toEpoch: BASE + DAY,
    });

    expect(result.pages).toBe(2);
    expect(result.coveredFrom).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('過去方向のページング');
  });

  it('maxPages に達したら警告付きで打ち切る', async () => {
    const messages = Array.from({ length: 1000 }, (_, i) => message(i, BASE - (1000 - i) * 60));
    const api = new FakeChatwork(messages);

    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - 365 * DAY,
      toEpoch: BASE + DAY,
      maxPages: 2,
    });

    expect(result.pages).toBe(2);
    expect(result.coveredFrom).toBe(false);
    expect(result.warnings[0]).toContain('最大ページ数');
  });

  it('進捗コールバックがページごとに呼ばれる', async () => {
    const messages = Array.from({ length: 150 }, (_, i) => message(i, BASE + i * 60));
    const api = new FakeChatwork(messages);
    const progress: number[] = [];

    await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE + DAY,
      onProgress: (p) => progress.push(p.total),
    });

    expect(progress.length).toBeGreaterThanOrEqual(2);
    // 累計件数は単調増加
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.at(-1)).toBe(150);
  });

  it('期間内に1件も無ければ空配列を返す', async () => {
    const api = new FakeChatwork([message(0, BASE - 100 * DAY)]);

    const result = await fetchMessagesInRange(api, {
      roomId: '1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE,
    });

    expect(result.messages).toEqual([]);
  });
});

describe('compareMessageId', () => {
  it('桁数の違う数値文字列を数値として比較する', () => {
    expect(compareMessageId('99', '100')).toBeLessThan(0);
    expect(compareMessageId('100', '99')).toBeGreaterThan(0);
  });

  it('同じ桁数なら辞書順', () => {
    expect(compareMessageId('100', '101')).toBeLessThan(0);
    expect(compareMessageId('100', '100')).toBe(0);
  });
});
