import { describe, expect, it } from 'vitest';
import {
  compareTs,
  fetchChannelMessages,
  isThreadParent,
  tsToEpoch,
  type SlackMessageSource,
} from '../src/slack/pager.js';
import type { SlackMessage } from '../src/slack/types.js';

const DAY = 86_400;
/** 2026-07-01 00:00:00 UTC */
const BASE = 1_782_864_000;

function message(index: number, epoch: number, extra: Partial<SlackMessage> = {}): SlackMessage {
  return {
    ts: `${epoch}.${String(index).padStart(6, '0')}`,
    type: 'message',
    user: 'U1111',
    text: `本文 ${index}`,
    ...extra,
  };
}

/**
 * conversations.history を模したフェイク。
 * oldest/latest で絞り込み、新しい順に pageSize 件ずつカーソルで返す。
 */
class FakeSlack implements SlackMessageSource {
  readonly historyCalls: Array<{ cursor?: string; limit: number }> = [];
  readonly replyCalls: string[] = [];

  constructor(
    private readonly all: SlackMessage[],
    private readonly threads: Map<string, SlackMessage[]> = new Map(),
    private readonly pageSize: number | null = null,
  ) {}

  async getHistoryPage(params: {
    channel: string;
    oldest: string;
    latest: string;
    limit: number;
    cursor?: string;
  }) {
    this.historyCalls.push({ cursor: params.cursor, limit: params.limit });

    const oldest = Number(params.oldest);
    const latest = Number(params.latest);
    const inRange = this.all
      .filter((m) => tsToEpoch(m.ts) >= oldest && tsToEpoch(m.ts) <= latest)
      .sort((a, b) => compareTs(b.ts, a.ts)); // Slack は新しい順に返す

    const size = this.pageSize ?? params.limit;
    const offset = params.cursor ? Number(params.cursor) : 0;
    const slice = inRange.slice(offset, offset + size);
    const nextOffset = offset + size;

    return {
      messages: slice,
      nextCursor: nextOffset < inRange.length ? String(nextOffset) : undefined,
      hasMore: nextOffset < inRange.length,
    };
  }

  async getThreadReplies(_channel: string, threadTs: string): Promise<SlackMessage[]> {
    this.replyCalls.push(threadTs);
    return this.threads.get(threadTs) ?? [];
  }
}

describe('fetchChannelMessages', () => {
  it('1ページで収まる場合は1リクエストで終わる', async () => {
    const api = new FakeSlack(Array.from({ length: 10 }, (_, i) => message(i, BASE + i * 60)));

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE + DAY,
      includeThreads: false,
    });

    expect(api.historyCalls).toHaveLength(1);
    expect(result.messages).toHaveLength(10);
    expect(result.warnings).toEqual([]);
  });

  it('カーソルを辿って全ページ取得する', async () => {
    const api = new FakeSlack(Array.from({ length: 450 }, (_, i) => message(i, BASE + i * 60)));

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE - DAY,
      toEpoch: BASE + 10 * DAY,
      pageLimit: 200,
      includeThreads: false,
    });

    expect(result.pages).toBe(3);
    expect(result.messages).toHaveLength(450);
    expect(api.historyCalls[0]?.cursor).toBeUndefined();
    expect(api.historyCalls[1]?.cursor).toBeDefined();
  });

  it('期間外のメッセージは API 側で絞られ、結果にも含まれない', async () => {
    const api = new FakeSlack([
      message(0, BASE - 10 * DAY),
      message(1, BASE + 60),
      message(2, BASE + 120),
      message(3, BASE + 10 * DAY),
    ]);

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
      includeThreads: false,
    });

    expect(result.messages.map((m) => m.text)).toEqual(['本文 1', '本文 2']);
  });

  it('結果は時刻の昇順に並ぶ', async () => {
    const api = new FakeSlack([
      message(0, BASE + 300),
      message(1, BASE + 100),
      message(2, BASE + 200),
    ]);

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
      includeThreads: false,
    });

    expect(result.messages.map((m) => Math.floor(tsToEpoch(m.ts)))).toEqual([
      BASE + 100,
      BASE + 200,
      BASE + 300,
    ]);
  });

  it('スレッドの返信を取得して結果に含める', async () => {
    const parentTs = `${BASE + 100}.000000`;
    const parent = message(0, BASE + 100, { ts: parentTs, thread_ts: parentTs, reply_count: 2 });
    const threads = new Map([
      [
        parentTs,
        [
          parent,
          message(1, BASE + 200, { thread_ts: parentTs }),
          message(2, BASE + 300, { thread_ts: parentTs }),
        ],
      ],
    ]);
    const api = new FakeSlack([parent], threads);

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
    });

    expect(api.replyCalls).toEqual([parentTs]);
    expect(result.threadsFetched).toBe(1);
    expect(result.messages).toHaveLength(3);
  });

  it('--no-threads 相当なら conversations.replies を呼ばない', async () => {
    const parentTs = `${BASE + 100}.000000`;
    const parent = message(0, BASE + 100, { ts: parentTs, thread_ts: parentTs, reply_count: 5 });
    const api = new FakeSlack([parent]);

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
      includeThreads: false,
    });

    expect(api.replyCalls).toEqual([]);
    expect(result.threadsFetched).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('期間より後のスレッド返信は含めない', async () => {
    const parentTs = `${BASE + 100}.000000`;
    const parent = message(0, BASE + 100, { ts: parentTs, thread_ts: parentTs, reply_count: 1 });
    const threads = new Map([
      [parentTs, [parent, message(1, BASE + 10 * DAY, { thread_ts: parentTs })]],
    ]);
    const api = new FakeSlack([parent], threads);

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
    });

    expect(result.messages).toHaveLength(1);
  });

  it('スレッドを取得したときは、期間前に始まったスレッドの取りこぼしを警告する', async () => {
    const parentTs = `${BASE + 100}.000000`;
    const parent = message(0, BASE + 100, { ts: parentTs, thread_ts: parentTs, reply_count: 1 });
    const api = new FakeSlack([parent], new Map([[parentTs, [parent]]]));

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
    });

    // 毎回同じ内容なので警告ではなく「補足」として返す
    expect(result.warnings).toEqual([]);
    expect(result.notes.some((n) => n.includes('期間の開始より前に始まったスレッド'))).toBe(true);
  });

  it('返信を取りに行くスレッド数の上限を超えたら警告する', async () => {
    const parents = Array.from({ length: 5 }, (_, i) => {
      const ts = `${BASE + i * 60}.000000`;
      return message(i, BASE + i * 60, { ts, thread_ts: ts, reply_count: 1 });
    });
    const api = new FakeSlack(parents, new Map(parents.map((p) => [p.ts, [p]])));

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
      maxThreads: 2,
    });

    expect(result.threadsFetched).toBe(2);
    expect(result.warnings.some((w) => w.includes('上限（2）'))).toBe(true);
  });

  it('maxPages に達したら警告付きで打ち切る', async () => {
    const api = new FakeSlack(Array.from({ length: 1000 }, (_, i) => message(i, BASE + i * 60)));

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + 100 * DAY,
      pageLimit: 100,
      maxPages: 2,
      includeThreads: false,
    });

    expect(result.pages).toBe(2);
    expect(result.warnings.some((w) => w.includes('最大ページ数'))).toBe(true);
  });

  it('1回15件しか返らない場合はレート制限の可能性を警告する', async () => {
    // 200件要求しても15件しか返さないサーバを模す（Marketplace 未掲載アプリの制限）
    const api = new FakeSlack(
      Array.from({ length: 60 }, (_, i) => message(i, BASE + i * 60)),
      new Map(),
      15,
    );

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
      pageLimit: 200,
      includeThreads: false,
    });

    expect(result.messages).toHaveLength(60);
    expect(result.warnings.some((w) => w.includes('15件'))).toBe(true);
  });

  it('通常の取得では15件制限の警告を出さない', async () => {
    const api = new FakeSlack(Array.from({ length: 300 }, (_, i) => message(i, BASE + i * 60)));

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY * 10,
      pageLimit: 200,
      includeThreads: false,
    });

    expect(result.warnings.some((w) => w.includes('15件'))).toBe(false);
  });

  it('期間内に1件も無ければ空配列を返す', async () => {
    const api = new FakeSlack([message(0, BASE - 100 * DAY)]);

    const result = await fetchChannelMessages(api, {
      channelId: 'C1',
      fromEpoch: BASE,
      toEpoch: BASE + DAY,
      includeThreads: false,
    });

    expect(result.messages).toEqual([]);
  });
});

describe('tsToEpoch / compareTs', () => {
  it('ts を秒に変換する', () => {
    expect(tsToEpoch('1756400000.123456')).toBeCloseTo(1_756_400_000.123456, 5);
  });

  it('数値として比較する（文字列比較では順序が狂うケース）', () => {
    expect(compareTs('999999999.000000', '1756400000.000000')).toBeLessThan(0);
    expect(compareTs('1756400000.000002', '1756400000.000001')).toBeGreaterThan(0);
  });
});

describe('isThreadParent', () => {
  it('返信を持つ親メッセージだけ true', () => {
    expect(isThreadParent({ ts: '1.0', thread_ts: '1.0', reply_count: 3 })).toBe(true);
    expect(isThreadParent({ ts: '1.0', thread_ts: '1.0', reply_count: 0 })).toBe(false);
    // 返信そのものは親ではない
    expect(isThreadParent({ ts: '2.0', thread_ts: '1.0', reply_count: 3 })).toBe(false);
    expect(isThreadParent({ ts: '1.0' })).toBe(false);
  });
});
