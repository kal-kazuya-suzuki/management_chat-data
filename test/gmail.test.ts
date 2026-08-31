import { describe, expect, it, vi } from 'vitest';
import { ArgError, parseGmailExportArgs } from '../src/args.js';
import { AccessTokenProvider, GmailAuthError } from '../src/gmail/auth.js';
import { GmailApiError, GmailClient, type FetchLike } from '../src/gmail/client.js';
import {
  buildGmailQuery,
  fetchThreadsInRange,
  type GmailMessageSource,
} from '../src/gmail/pager.js';
import {
  displayNameOf,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  type GmailThread,
} from '../src/gmail/types.js';
import { messageEpoch, toGmailExportedMessage, toTimeline } from '../src/output/gmail-record.js';
import { filterMineGmail, groupByThread } from '../src/output/gmail-markdown.js';

const JST = 540;
/** 2026-07-01 00:00:00 UTC */
const BASE = 1_782_864_000;

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

const STATIC_TOKEN = { getAccessToken: async () => 'ya29.token' };

describe('parseAddressList / parseAddress', () => {
  it('表示名とアドレスを分ける', () => {
    expect(parseAddress('山田太郎 <yamada@example.com>')).toEqual({
      name: '山田太郎',
      email: 'yamada@example.com',
    });
  });

  it('表示名が無ければ null', () => {
    expect(parseAddress('yamada@example.com')).toEqual({ name: null, email: 'yamada@example.com' });
  });

  it('アドレスは小文字化する', () => {
    expect(parseAddress('<Yamada@Example.COM>')?.email).toBe('yamada@example.com');
  });

  it('引用符付きの表示名からクォートを外す', () => {
    expect(parseAddress('"山田 太郎" <yamada@example.com>')?.name).toBe('山田 太郎');
  });

  it('複数のアドレスを分解する', () => {
    const list = parseAddressList('a@example.com, 山田 <b@example.com>');
    expect(list.map((x) => x.email)).toEqual(['a@example.com', 'b@example.com']);
  });

  it('表示名にカンマが入っていても壊れない', () => {
    const list = parseAddressList('"田中, 花子" <tanaka@example.com>, sato@example.com');
    expect(list.map((x) => x.email)).toEqual(['tanaka@example.com', 'sato@example.com']);
    expect(list[0]?.name).toBe('田中, 花子');
  });

  it('空ヘッダは空配列', () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('displayNameOf / normalizeSubject', () => {
  it('表示名が無ければアドレスのローカル部を使う', () => {
    expect(displayNameOf({ name: null, email: 'yamada@example.com' })).toBe('yamada');
    expect(displayNameOf({ name: '山田', email: 'yamada@example.com' })).toBe('山田');
    expect(displayNameOf(null)).toBe('(不明な送信者)');
  });

  it('件名から Re: / Fwd: を外す', () => {
    expect(normalizeSubject('Re: 見積の件')).toBe('見積の件');
    expect(normalizeSubject('RE: Fwd: 見積の件')).toBe('見積の件');
    expect(normalizeSubject('返信: 見積の件')).toBe('見積の件');
    expect(normalizeSubject(null)).toBe('(件名なし)');
    expect(normalizeSubject('見積の件')).toBe('見積の件');
  });
});

describe('buildGmailQuery', () => {
  it('自分の送信メールと期間で絞る', () => {
    expect(buildGmailQuery({ fromEpoch: 100, toEpoch: 200 })).toBe('from:me after:100 before:201');
  });

  it('before は +1 して指定日の終わりを含める', () => {
    const query = buildGmailQuery({ fromEpoch: BASE, toEpoch: BASE + 86_399 });
    expect(query).toContain(`before:${BASE + 86_400}`);
  });

  it('--all-mail 相当なら from:me を付けない', () => {
    expect(buildGmailQuery({ fromEpoch: 100, toEpoch: 200, onlySent: false })).toBe(
      'after:100 before:201',
    );
  });

  it('追加クエリを連結する', () => {
    expect(
      buildGmailQuery({ fromEpoch: 100, toEpoch: 200, extraQuery: 'to:example.co.jp' }),
    ).toBe('from:me after:100 before:201 to:example.co.jp');
  });
});

/** Gmail API を模したフェイク。 */
class FakeGmail implements GmailMessageSource {
  readonly listCalls: Array<string | undefined> = [];
  readonly threadCalls: string[] = [];

  constructor(
    private readonly refs: Array<{ id: string; threadId: string }>,
    private readonly threads: Map<string, GmailThread> = new Map(),
    private readonly pageSize = 500,
  ) {}

  async listMessagePage(params: { query: string; maxResults: number; pageToken?: string }) {
    this.listCalls.push(params.pageToken);
    const offset = params.pageToken ? Number(params.pageToken) : 0;
    const size = Math.min(this.pageSize, params.maxResults);
    const slice = this.refs.slice(offset, offset + size);
    const next = offset + size;
    return {
      messages: slice,
      nextPageToken: next < this.refs.length ? String(next) : undefined,
    };
  }

  async getThread(threadId: string): Promise<GmailThread> {
    this.threadCalls.push(threadId);
    return this.threads.get(threadId) ?? { id: threadId, messages: [] };
  }
}

describe('fetchThreadsInRange', () => {
  it('1ページで収まる場合は1回で列挙が終わる', async () => {
    const api = new FakeGmail([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ]);

    const result = await fetchThreadsInRange(api, { fromEpoch: BASE, toEpoch: BASE + 86_400 });

    expect(api.listCalls).toEqual([undefined]);
    expect(result.matchedMessages).toBe(2);
    expect(api.threadCalls).toEqual(['t1', 't2']);
  });

  it('同じスレッドの複数メールは1回だけ取得する', async () => {
    const api = new FakeGmail([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't1' },
      { id: 'm3', threadId: 't2' },
    ]);

    const result = await fetchThreadsInRange(api, { fromEpoch: BASE, toEpoch: BASE + 86_400 });

    expect(result.matchedMessages).toBe(3);
    expect(api.threadCalls).toEqual(['t1', 't2']);
  });

  it('pageToken を辿って全件列挙する', async () => {
    const refs = Array.from({ length: 250 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }));
    const api = new FakeGmail(refs, new Map(), 100);

    const result = await fetchThreadsInRange(api, {
      fromEpoch: BASE,
      toEpoch: BASE + 86_400,
      pageSize: 100,
    });

    expect(result.pages).toBe(3);
    expect(result.matchedMessages).toBe(250);
  });

  it('maxThreads を超えたら警告して打ち切る', async () => {
    const refs = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }));
    const api = new FakeGmail(refs);

    const result = await fetchThreadsInRange(api, {
      fromEpoch: BASE,
      toEpoch: BASE + 86_400,
      maxThreads: 2,
    });

    expect(api.threadCalls).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('上限（2）'))).toBe(true);
  });

  it('maxPages に達したら警告して打ち切る', async () => {
    const refs = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}` }));
    const api = new FakeGmail(refs, new Map(), 100);

    const result = await fetchThreadsInRange(api, {
      fromEpoch: BASE,
      toEpoch: BASE + 86_400,
      pageSize: 100,
      maxPages: 2,
    });

    expect(result.pages).toBe(2);
    expect(result.warnings.some((w) => w.includes('最大ページ数'))).toBe(true);
  });

  it('スレッドを取得したときは期間の判定基準を補足として返す', async () => {
    const api = new FakeGmail([{ id: 'm1', threadId: 't1' }]);
    const result = await fetchThreadsInRange(api, { fromEpoch: BASE, toEpoch: BASE + 86_400 });

    expect(result.warnings).toEqual([]);
    expect(result.notes.some((n) => n.includes('自分が送信したメールの日付'))).toBe(true);
  });

  it('該当が無ければスレッドを取りに行かない', async () => {
    const api = new FakeGmail([]);
    const result = await fetchThreadsInRange(api, { fromEpoch: BASE, toEpoch: BASE + 86_400 });

    expect(result.threads).toEqual([]);
    expect(api.threadCalls).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

describe('toGmailExportedMessage', () => {
  const thread: GmailThread = {
    id: 't1',
    messages: [
      {
        id: 'm1',
        threadId: 't1',
        internalDate: String(BASE * 1000),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: '田中花子 <tanaka@example.com>' },
            { name: 'To', value: 'kazuya@kal.co.jp' },
            { name: 'Subject', value: '見積の件' },
            { name: 'Message-ID', value: '<msg-1@example.com>' },
          ],
          body: { data: b64url('見積の件、いかがでしょうか。') },
        },
      },
      {
        id: 'm2',
        threadId: 't1',
        internalDate: String((BASE + 3600) * 1000),
        labelIds: ['SENT'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: '鈴木一也 <kazuya@kal.co.jp>' },
            { name: 'To', value: 'tanaka@example.com' },
            { name: 'Cc', value: 'sato@example.com' },
            { name: 'Subject', value: 'Re: 見積の件' },
            { name: 'In-Reply-To', value: '<msg-1@example.com>' },
          ],
          body: {
            data: b64url(
              '本日中にお送りします。\n\n-- \n株式会社KAL 鈴木\nTEL: 03-0000-0000\n\n> 見積の件、いかがでしょうか。',
            ),
          },
        },
      },
    ],
  };

  const context = { myAddress: 'kazuya@kal.co.jp', tzOffsetMinutes: JST };

  it('相手のメールを変換する', () => {
    const record = toGmailExportedMessage(thread.messages![0]!, thread, context);
    expect(record).toMatchObject({
      message_id: 'm1',
      room_id: 't1',
      room_name: '見積の件',
      account_id: 'tanaka@example.com',
      account_name: '田中花子',
      body_plain: '見積の件、いかがでしょうか。',
      send_time: '2026-07-01T09:00:00+09:00',
      is_mine: false,
      reply_to: null,
      mentions: ['kazuya@kal.co.jp'],
    });
  });

  it('自分のメールは is_mine が true になり、引用と署名が落ちる', () => {
    const record = toGmailExportedMessage(thread.messages![1]!, thread, context);
    expect(record.is_mine).toBe(true);
    expect(record.body_plain).toBe('本日中にお送りします。');
    expect(record.room_name).toBe('見積の件'); // Re: が外れる
    expect(record.subject).toBe('Re: 見積の件');
    expect(record.mentions).toEqual(['tanaka@example.com', 'sato@example.com']);
  });

  it('In-Reply-To から返信先のメールを引く', () => {
    const record = toGmailExportedMessage(thread.messages![1]!, thread, context);
    expect(record.reply_to).toBe('m1');
  });

  it('--keep-quotes / --keep-signature で残せる', () => {
    const record = toGmailExportedMessage(thread.messages![1]!, thread, {
      ...context,
      keepQuotes: true,
      keepSignature: true,
    });
    expect(record.body_plain).toContain('> 見積の件、いかがでしょうか。');
    expect(record.body_plain).toContain('TEL: 03-0000-0000');
  });

  it('スレッドを時系列に並べる', () => {
    const timeline = toTimeline([thread], context);
    expect(timeline.map((m) => m.message_id)).toEqual(['m1', 'm2']);
  });
});

describe('messageEpoch', () => {
  it('internalDate（ミリ秒）を秒にする', () => {
    expect(messageEpoch({ id: 'm', threadId: 't', internalDate: String(BASE * 1000) })).toBe(BASE);
  });

  it('internalDate が無ければ Date ヘッダを見る', () => {
    const epoch = messageEpoch({
      id: 'm',
      threadId: 't',
      payload: { headers: [{ name: 'Date', value: 'Wed, 01 Jul 2026 00:00:00 +0000' }] },
    });
    expect(epoch).toBe(BASE);
  });

  it('どちらも無ければ 0', () => {
    expect(messageEpoch({ id: 'm', threadId: 't' })).toBe(0);
  });
});

describe('groupByThread / filterMineGmail', () => {
  const base = {
    room_id: 't1',
    room_name: '件名',
    body: '',
    update_time: null,
    reply_to: null,
    mentions: [],
    thread_id: 't1',
    subject: '件名',
    from: '',
    to: [],
    cc: [],
    files: [],
    body_source: 'text/plain' as const,
    labels: [],
  };
  const messages = [
    { ...base, message_id: 'a', account_id: 'me@x.com', account_name: '自分', body_plain: 'あ'.repeat(30), send_time: '2026-07-01T09:00:00+09:00', is_mine: true },
    { ...base, message_id: 'b', account_id: 'other@x.com', account_name: '相手', body_plain: '返信', send_time: '2026-07-01T10:00:00+09:00', is_mine: false },
    { ...base, thread_id: 't2', room_id: 't2', message_id: 'c', account_id: 'me@x.com', account_name: '自分', body_plain: '短い', send_time: '2026-07-02T09:00:00+09:00', is_mine: true },
  ];

  it('スレッドごとにまとめる', () => {
    const groups = groupByThread(messages);
    expect(groups.map((g) => g.threadId)).toEqual(['t1', 't2']);
    expect(groups[0]?.messages).toHaveLength(2);
  });

  it('自分の送信メールを文字数で絞る', () => {
    expect(filterMineGmail(messages, { myAccountId: 'me@x.com', minLength: 20 }).map((m) => m.message_id)).toEqual(['a']);
  });
});

describe('AccessTokenProvider', () => {
  it('リフレッシュトークンからアクセストークンを取る', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'ya29.abc', expires_in: 3600 }));
    const provider = new AccessTokenProvider(
      { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      () => 1000,
      fetchImpl as unknown as typeof fetch,
    );

    expect(await provider.getAccessToken()).toBe('ya29.abc');
  });

  it('期限内は取り直さない', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'ya29.abc', expires_in: 3600 }));
    const provider = new AccessTokenProvider(
      { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      () => 1000,
      fetchImpl as unknown as typeof fetch,
    );

    await provider.getAccessToken();
    await provider.getAccessToken();
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('期限が切れたら取り直す', async () => {
    // Response のボディは一度しか読めないので、呼び出しごとに作り直す
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ access_token: 'ya29.abc', expires_in: 3600 }));
    let now = 1000;
    const provider = new AccessTokenProvider(
      { clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' },
      () => now,
      fetchImpl as unknown as typeof fetch,
    );

    await provider.getAccessToken();
    now += 3_600_000;
    await provider.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invalid_grant のときは再認証を促す', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const provider = new AccessTokenProvider(
      { clientId: 'id', clientSecret: 'secret', refreshToken: 'stale' },
      () => 1000,
      fetchImpl as unknown as typeof fetch,
    );

    await expect(provider.getAccessToken()).rejects.toThrow(GmailAuthError);
    await expect(provider.getAccessToken()).rejects.toThrow(/gmail:auth/);
  });
});

describe('GmailClient', () => {
  function makeClient(fetchImpl: FetchLike, clock: ReturnType<typeof fakeClock>, maxRetries = 5) {
    return new GmailClient({
      tokenSource: STATIC_TOKEN,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
      maxRetries,
      minIntervalMs: 0,
    });
  }

  it('Bearer トークンを付けて呼び出す', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => jsonResponse({ labels: [] }));
    const client = makeClient(fetchImpl, fakeClock());

    await client.listLabels();

    const [url, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/labels');
    expect(init.headers.Authorization).toBe('Bearer ya29.token');
  });

  it('検索クエリとページトークンを渡す', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => jsonResponse({ messages: [] }));
    const client = makeClient(fetchImpl, fakeClock());

    await client.listMessagePage({ query: 'from:me after:1', maxResults: 500, pageToken: 'tok' });

    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(url).toContain('q=from%3Ame+after%3A1');
    expect(url).toContain('maxResults=500');
    expect(url).toContain('pageToken=tok');
  });

  it('429 は待って再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: 429 } }), {
          status: 429,
          headers: { 'retry-after': '20' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ messages: [] }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.listMessagePage({ query: 'q', maxResults: 10 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.waits[0]).toBe(20_500);
    expect(client.totalRateLimitHits).toBe(1);
  });

  it('403 rateLimitExceeded は再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ messages: [] }));
    const client = makeClient(fetchImpl, fakeClock());

    await client.listMessagePage({ query: 'q', maxResults: 10 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('403 の権限エラーは再試行せず即エラー', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementation(async () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: 'Insufficient Permission',
              errors: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
            },
          },
          403,
        ),
      );
    const client = makeClient(fetchImpl, fakeClock());

    await expect(client.listMessagePage({ query: 'q', maxResults: 10 })).rejects.toThrow(
      /gmail.readonly/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('5xx は指数バックオフで再試行する', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ messages: [] }));
    const clock = fakeClock();
    const client = makeClient(fetchImpl, clock);

    await client.listMessagePage({ query: 'q', maxResults: 10 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(clock.waits[1]).toBeGreaterThan(clock.waits[0] as number);
  });

  it('404 は即エラー', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => jsonResponse({ error: { code: 404 } }, 404));
    const client = makeClient(fetchImpl, fakeClock());

    await expect(client.getThread('t1')).rejects.toThrow(GmailApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('parseGmailExportArgs', () => {
  const CONTEXT = { today: '2026-08-30' };

  it('既定は直近30日・both・引用と署名を除去', () => {
    const args = parseGmailExportArgs([], CONTEXT);
    expect(args.from).toBe('2026-08-01');
    expect(args.to).toBe('2026-08-30');
    expect(args.format).toBe('both');
    expect(args.allMail).toBe(false);
    expect(args.keepQuotes).toBe(false);
    expect(args.keepSignature).toBe(false);
  });

  it('チャンネル系のオプションは受け付けない', () => {
    expect(() => parseGmailExportArgs(['--channel=C1'], CONTEXT)).toThrow(ArgError);
    expect(() => parseGmailExportArgs(['--room=1'], CONTEXT)).toThrow(ArgError);
  });

  it('--query / --all-mail / --keep-quotes を読む', () => {
    const args = parseGmailExportArgs(
      ['--query=to:example.co.jp', '--all-mail', '--keep-quotes'],
      CONTEXT,
    );
    expect(args.query).toBe('to:example.co.jp');
    expect(args.allMail).toBe(true);
    expect(args.keepQuotes).toBe(true);
  });

  it('--page-size は 1〜500', () => {
    expect(parseGmailExportArgs(['--page-size=100'], CONTEXT).pageSize).toBe(100);
    expect(() => parseGmailExportArgs(['--page-size=501'], CONTEXT)).toThrow(/1〜500/);
  });

  it('--from が --to より後ならエラー', () => {
    expect(() => parseGmailExportArgs(['--from=2026-08-30', '--to=2026-08-01'], CONTEXT)).toThrow(
      /--from が --to より後/,
    );
  });
});
