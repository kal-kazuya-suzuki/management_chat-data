import { describe, expect, it, vi } from 'vitest';
import { SlackApiError, SlackClient, type FetchLike } from '../src/slack/client.js';
import { UserDirectory } from '../src/slack/users.js';
import { channelKind, pickUserName } from '../src/slack/types.js';

function slackResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** 実時間を消費しない偽の時計。 */
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

function makeClient(fetchImpl: FetchLike, clock: ReturnType<typeof fakeClock>, maxRetries = 5) {
  return new SlackClient({
    token: 'xoxb-dummy',
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
    maxRetries,
    minIntervalMs: 0,
  });
}

describe('SlackClient', () => {
  it('Bearer トークンを付けて呼び出す', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () => slackResponse({ ok: true, user_id: 'U1', user: 'me', team: 'T', team_id: 'T1' }));
    const client = makeClient(fetchImpl, fakeClock());

    await client.authTest();

    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://slack.com/api/auth.test');
    expect(init.headers.Authorization).toBe('Bearer xoxb-dummy');
  });

  it('ok:false は HTTP 200 でもエラーにする', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () => slackResponse({ ok: false, error: 'channel_not_found' }));
    const client = makeClient(fetchImpl, fakeClock());

    await expect(client.getHistoryPage({ channel: 'C1', oldest: '0', latest: '1', limit: 200 })).rejects.toThrow(
      SlackApiError,
    );
    // 再試行しても無駄なエラーなので1回で終わる
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('権限不足のときは必要なスコープをエラーに含める', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () =>
        slackResponse({ ok: false, error: 'missing_scope', needed: 'channels:history' }),
      );
    const client = makeClient(fetchImpl, fakeClock());

    await expect(client.listUsers()).rejects.toThrow(/channels:history/);
  });

  it('429 は Retry-After に従って待って再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(slackResponse({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '30' } }))
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [] }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getHistoryPage({ channel: 'C1', oldest: '0', latest: '1', limit: 200 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Retry-After の 30秒 + 余裕の 0.5秒
    expect(clock.waits[0]).toBe(30_500);
    expect(client.totalRateLimitHits).toBe(1);
  });

  it('HTTP 200 の ok:false ratelimited も待って再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(slackResponse({ ok: false, error: 'ratelimited' }, { headers: { 'retry-after': '10' } }))
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [] }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getHistoryPage({ channel: 'C1', oldest: '0', latest: '1', limit: 200 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.waits[0]).toBe(10_500);
  });

  it('429 が続けば maxRetries 到達でエラーになる', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () =>
        slackResponse({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '1' } }),
      );
    const client = makeClient(fetchImpl, fakeClock(), 2);

    await expect(client.getHistoryPage({ channel: 'C1', oldest: '0', latest: '1', limit: 200 })).rejects.toThrow(
      SlackApiError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('5xx は指数バックオフで再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(slackResponse({}, { status: 500 }))
      .mockResolvedValueOnce(slackResponse({}, { status: 503 }))
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [] }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.getHistoryPage({ channel: 'C1', oldest: '0', latest: '1', limit: 200 });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.waits[1]).toBeGreaterThan(clock.waits[0] as number);
  });

  it('conversations.history に期間とページ上限を渡す', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () => slackResponse({ ok: true, messages: [] }));
    const client = makeClient(fetchImpl, fakeClock());

    await client.getHistoryPage({ channel: 'C1', oldest: '100', latest: '200', limit: 200, cursor: 'abc' });

    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(url).toContain('channel=C1');
    expect(url).toContain('oldest=100');
    expect(url).toContain('latest=200');
    expect(url).toContain('limit=200');
    expect(url).toContain('cursor=abc');
    expect(url).toContain('inclusive=true');
  });

  it('カーソルを辿ってチャンネル一覧を全件取得する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        slackResponse({
          ok: true,
          channels: [{ id: 'C1', name: 'general' }],
          response_metadata: { next_cursor: 'next' },
        }),
      )
      .mockResolvedValueOnce(
        slackResponse({ ok: true, channels: [{ id: 'C2', name: 'random' }], response_metadata: { next_cursor: '' } }),
      );
    const client = makeClient(fetchImpl, fakeClock());

    const channels = await client.listChannels();

    expect(channels.map((c) => c.id)).toEqual(['C1', 'C2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('権限不足のときはパブリックチャンネルだけに絞って取り直す', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async (url) => {
      // private_channel を含む要求は missing_scope で失敗させる
      if (url.includes('private_channel')) {
        return slackResponse({ ok: false, error: 'missing_scope', needed: 'groups:read' });
      }
      return slackResponse({ ok: true, channels: [{ id: 'C1', name: 'general' }] });
    });
    const client = makeClient(fetchImpl, fakeClock());

    const channels = await client.listChannels();

    expect(channels.map((c) => c.id)).toEqual(['C1']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('types=public_channel');
    expect(fetchImpl.mock.calls[1]?.[0]).not.toContain('private_channel');
  });

  it('パブリックだけを要求して権限不足なら、そのままエラーにする', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () => slackResponse({ ok: false, error: 'missing_scope', needed: 'channels:read' }));
    const client = makeClient(fetchImpl, fakeClock());

    await expect(client.listChannels({ types: 'public_channel' })).rejects.toThrow(SlackApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('スレッド返信もカーソルを辿る', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        slackResponse({ ok: true, messages: [{ ts: '1.0' }], response_metadata: { next_cursor: 'n' } }),
      )
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [{ ts: '2.0' }] }));
    const client = makeClient(fetchImpl, fakeClock());

    const replies = await client.getThreadReplies('C1', '1.0');
    expect(replies.map((m) => m.ts)).toEqual(['1.0', '2.0']);
  });

  it('リクエスト数を数えている', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(slackResponse({}, { status: 500 }))
      .mockResolvedValueOnce(slackResponse({ ok: true, messages: [] }));
    const client = makeClient(fetchImpl, fakeClock());

    await client.getHistoryPage({ channel: 'C1', oldest: '0', latest: '1', limit: 200 });
    expect(client.totalRequests).toBe(2);
  });
});

describe('UserDirectory', () => {
  it('users.list は1回しか呼ばない', async () => {
    let calls = 0;
    const directory = new UserDirectory({
      listUsers: async () => {
        calls += 1;
        return [{ id: 'U1', name: 'kazuya', profile: { display_name: '鈴木一也' } }];
      },
    });

    await directory.load();
    await directory.load();
    await directory.load();

    expect(calls).toBe(1);
    expect(directory.resolve('U1')).toBe('鈴木一也');
  });

  it('未知の user_id は fallback、それも無ければ ID を返す', async () => {
    const directory = new UserDirectory({ listUsers: async () => [] });
    await directory.load();

    expect(directory.resolve('U9', 'bot-name')).toBe('bot-name');
    expect(directory.resolve('U9')).toBe('U9');
    expect(directory.resolve(undefined)).toBe('(不明なユーザー)');
  });

  it('Bot を判別できる', async () => {
    const directory = new UserDirectory({
      listUsers: async () => [{ id: 'B1', name: 'bot', is_bot: true }],
    });
    await directory.load();

    expect(directory.isBot('B1')).toBe(true);
    expect(directory.isBot('U1')).toBe(false);
  });
});

describe('pickUserName', () => {
  it('display_name → real_name → name の順に選ぶ', () => {
    expect(pickUserName({ id: 'U1', profile: { display_name: '表示名', real_name: '本名' } })).toBe('表示名');
    expect(pickUserName({ id: 'U1', profile: { real_name: '本名' } })).toBe('本名');
    expect(pickUserName({ id: 'U1', name: 'handle' })).toBe('handle');
    expect(pickUserName({ id: 'U1' })).toBe('U1');
  });

  it('空文字の display_name は使わない', () => {
    expect(pickUserName({ id: 'U1', profile: { display_name: '  ', real_name: '本名' } })).toBe('本名');
  });
});

describe('channelKind', () => {
  it('チャンネル種別をラベルにする', () => {
    expect(channelKind({ id: 'C1' })).toBe('パブリック');
    expect(channelKind({ id: 'C1', is_private: true })).toBe('プライベート');
    expect(channelKind({ id: 'D1', is_im: true })).toBe('DM');
    expect(channelKind({ id: 'G1', is_mpim: true })).toBe('グループDM');
  });
});
