import { describe, expect, it, vi } from 'vitest';
import { ChatworkApiError, ChatworkClient, type FetchLike } from '../src/chatwork/client.js';
import { RateLimiter } from '../src/util/rate-limiter.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ errors: ['error'] }), { status, headers });
}

/**
 * 実際には待たない偽の時計。
 * sleep が呼ばれたら待機時間を記録しつつ仮想時刻を進める（テストが実時間を消費しない）。
 */
function fakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  const waits: number[] = [];
  return {
    waits,
    now: () => current,
    sleep: async (ms: number) => {
      waits.push(ms);
      current += ms;
    },
  };
}

function makeClient(
  fetchImpl: FetchLike,
  clock: ReturnType<typeof fakeClock>,
  maxRetries = 5,
) {
  return new ChatworkClient({
    token: 'dummy-token',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    maxRetries,
    minIntervalMs: 0,
  });
}

describe('ChatworkClient', () => {
  it('認証ヘッダを付けて GET する', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse([{ room_id: 1 }]));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getRooms();

    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.chatwork.com/v2/rooms');
    expect(init.headers['X-ChatWorkToken']).toBe('dummy-token');
  });

  it('メッセージ取得は force=1 を付ける', async () => {
    // Response のボディは一度しか読めないので、呼び出しごとに新しく作る
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => jsonResponse([]));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getMessages('12345');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.chatwork.com/v2/rooms/12345/messages?force=1');

    await client.getMessages('12345', { messageId: '999' });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://api.chatwork.com/v2/rooms/12345/messages?force=1&message_id=999',
    );
  });

  it('204 No Content は null を返す', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    expect(await client.getMessages('1')).toBeNull();
  });

  it('429 は Retry-After 秒だけ待って再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(errorResponse(429, { 'retry-after': '30' }))
      .mockResolvedValueOnce(jsonResponse([{ message_id: '1' }]));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    const messages = await client.getMessages('1');

    expect(messages).toEqual([{ message_id: '1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.waits).toContain(30_000);
  });

  it('Retry-After が無ければ x-ratelimit-reset を見る', async () => {
    const clock = fakeClock();
    const resetAt = Math.floor(clock.now() / 1000) + 60;
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(errorResponse(429, { 'x-ratelimit-reset': String(resetAt) }))
      .mockResolvedValueOnce(jsonResponse([]));
    const client = makeClient(fetchImpl, clock);

    await client.getMessages('1');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // おおよそ60秒（+1秒の余裕）待つ
    expect(clock.waits[0]).toBeGreaterThan(55_000);
    expect(clock.waits[0]).toBeLessThan(65_000);
  });

  it('429 が続けば maxRetries 到達でエラーになる', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () => errorResponse(429, { 'retry-after': '1' }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock, 2);

    await expect(client.getMessages('1')).rejects.toThrow(ChatworkApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 初回 + リトライ2回
  });

  it('5xx は指数バックオフで再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(jsonResponse([]));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getMessages('1');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.waits).toHaveLength(2);
    expect(clock.waits[1]).toBeGreaterThan(clock.waits[0] as number); // 待機時間が伸びている
  });

  it('401 / 404 は再試行せず即エラー', async () => {
    for (const status of [400, 401, 403, 404]) {
      const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => errorResponse(status));
      const clock = fakeClock();
      const client = makeClient(fetchImpl, clock);

      await expect(client.getMessages('1')).rejects.toThrow(ChatworkApiError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('ネットワークエラーも再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse([]));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getMessages('1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('リクエスト数を数えている', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(jsonResponse([]));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getMessages('1');
    expect(client.totalRequests).toBe(2);
  });
});

describe('RateLimiter', () => {
  it('ウィンドウ上限を超えると次のリクエストを待たせる', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter({
      limit: 3,
      windowSeconds: 60,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    for (let i = 0; i < 3; i += 1) await limiter.acquire();
    expect(waits).toEqual([]);
    expect(limiter.remaining()).toBe(0);

    await limiter.acquire();
    expect(waits).toEqual([60_000]);
  });

  it('最小リクエスト間隔を守る', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter({
      limit: 100,
      windowSeconds: 60,
      minIntervalMs: 250,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([250]);
  });

  it('pauseFor でサーバ指示の待機を入れられる', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter({
      limit: 100,
      windowSeconds: 60,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    limiter.pauseFor(5_000);
    await limiter.acquire();
    expect(waits).toEqual([5_000]);
  });

  it('ウィンドウが過ぎれば枠が回復する', async () => {
    let now = 0;
    const limiter = new RateLimiter({
      limit: 2,
      windowSeconds: 60,
      now: () => now,
      sleep: async () => {},
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.remaining()).toBe(0);

    now += 61_000;
    expect(limiter.remaining()).toBe(2);
  });
});
