import { describe, expect, it } from 'vitest';
import { ArgError, parseChannelRefs, parseSlackExportArgs, isChannelId } from '../src/args.js';
import { UserDirectory } from '../src/slack/users.js';
import { isSystemMessage, toSlackExportedMessage } from '../src/output/slack-record.js';
import { buildFileName } from '../src/output/files.js';
import { renderMarkdown, type MarkdownContext } from '../src/output/markdown.js';
import type { SlackMessage } from '../src/slack/types.js';

const JST = 540;
const CONTEXT_ARGS = { today: '2026-08-30' };

async function makeDirectory(): Promise<UserDirectory> {
  const directory = new UserDirectory({
    listUsers: async () => [
      { id: 'U1111', profile: { display_name: '鈴木一也' } },
      { id: 'U2222', profile: { display_name: '田中花子' } },
    ],
  });
  await directory.load();
  return directory;
}

async function recordContext() {
  return {
    channelId: 'C0123ABCD',
    channelName: 'web-project',
    directory: await makeDirectory(),
    tzOffsetMinutes: JST,
    channelNames: new Map([['C0123ABCD', 'web-project']]),
  };
}

describe('toSlackExportedMessage', () => {
  it('Slack のメッセージを出力レコードに変換する', async () => {
    const message: SlackMessage = {
      // 1782864000 = 2026-07-01T00:00:00Z = JST 09:00
      ts: '1782864000.000100',
      user: 'U2222',
      text: '<@U1111> *本日中* に <https://example.com/spec|仕様書> をご確認ください',
    };

    const record = toSlackExportedMessage(message, await recordContext());

    expect(record).toMatchObject({
      message_id: '1782864000.000100',
      room_id: 'C0123ABCD',
      room_name: 'web-project',
      account_id: 'U2222',
      account_name: '田中花子',
      body_plain: '@鈴木一也 本日中 に 仕様書 をご確認ください',
      send_time: '2026-07-01T09:00:00+09:00',
      update_time: null,
      reply_to: null,
      mentions: ['U1111'],
      thread_ts: null,
      is_thread_parent: false,
      subtype: null,
    });
  });

  it('編集済みなら update_time が入る', async () => {
    const record = toSlackExportedMessage(
      { ts: '1782864000.000100', user: 'U1111', text: 'あ', edited: { ts: '1782867600.000000' } },
      await recordContext(),
    );
    expect(record.update_time).toBe('2026-07-01T10:00:00+09:00');
  });

  it('スレッドの返信は reply_to に親の ts が入る', async () => {
    const record = toSlackExportedMessage(
      { ts: '1782864100.000200', user: 'U1111', text: '承知しました', thread_ts: '1782864000.000100' },
      await recordContext(),
    );
    expect(record.reply_to).toBe('1782864000.000100');
    expect(record.is_thread_parent).toBe(false);
  });

  it('スレッドの親は reply_to が null で is_thread_parent が true', async () => {
    const record = toSlackExportedMessage(
      {
        ts: '1782864000.000100',
        user: 'U1111',
        text: '相談です',
        thread_ts: '1782864000.000100',
        reply_count: 2,
      },
      await recordContext(),
    );
    expect(record.reply_to).toBeNull();
    expect(record.is_thread_parent).toBe(true);
  });

  it('添付ファイル名を本文に補う', async () => {
    const record = toSlackExportedMessage(
      {
        ts: '1782864000.000100',
        user: 'U1111',
        text: '資料です',
        files: [{ name: '見積書.pdf' }, { title: '構成図.png' }],
      },
      await recordContext(),
    );
    expect(record.body_plain).toBe('資料です\n見積書.pdf\n構成図.png');
    expect(record.files).toEqual(['見積書.pdf', '構成図.png']);
  });

  it('本文が空でもファイルがあれば内容が残る', async () => {
    const record = toSlackExportedMessage(
      { ts: '1782864000.000100', user: 'U1111', files: [{ name: '議事録.docx' }] },
      await recordContext(),
    );
    expect(record.body_plain).toBe('議事録.docx');
  });

  it('Bot の発言は username を名前に使う', async () => {
    const record = toSlackExportedMessage(
      { ts: '1782864000.000100', bot_id: 'B1', username: 'GitHub', text: 'デプロイ完了' },
      await recordContext(),
    );
    expect(record.account_name).toBe('GitHub');
    expect(record.bot_id).toBe('B1');
  });
});

describe('isSystemMessage', () => {
  it('参加・退出などを判定する', () => {
    expect(isSystemMessage({ ts: '1.0', subtype: 'channel_join' })).toBe(true);
    expect(isSystemMessage({ ts: '1.0', subtype: 'channel_leave' })).toBe(true);
    expect(isSystemMessage({ ts: '1.0', subtype: 'channel_topic' })).toBe(true);
  });

  it('通常の発言や Bot の発言はシステムメッセージではない', () => {
    expect(isSystemMessage({ ts: '1.0' })).toBe(false);
    expect(isSystemMessage({ ts: '1.0', subtype: 'bot_message' })).toBe(false);
    expect(isSystemMessage({ ts: '1.0', subtype: 'thread_broadcast' })).toBe(false);
  });
});

describe('Slack の Markdown / ファイル名', () => {
  it('見出しのラベルが channel_id になる', () => {
    const context: MarkdownContext = {
      roomId: 'C0123ABCD',
      roomName: 'web-project',
      idLabel: 'channel_id',
      from: '2026-07-01',
      to: '2026-08-30',
      tzLabel: '+09:00',
      generatedAt: '2026-08-30T11:00:00+09:00',
    };
    const md = renderMarkdown([], context);
    expect(md).toContain('- channel_id: C0123ABCD');
    expect(md).not.toContain('room_id');
  });

  it('ファイル名の先頭が slack になる', () => {
    expect(
      buildFileName({
        platform: 'slack',
        roomId: 'C0123ABCD',
        roomName: 'web-project',
        from: '2026-07-01',
        to: '2026-08-30',
        mine: false,
        extension: 'json',
      }),
    ).toBe('slack_C0123ABCD_web-project_2026-07-01_2026-08-30.json');
  });
});

describe('parseSlackExportArgs', () => {
  it('基本的な指定を読み取る', () => {
    const args = parseSlackExportArgs(['--channel=C0123ABCD', '--from=2026-07-01'], CONTEXT_ARGS);
    expect(args.channels).toEqual(['C0123ABCD']);
    expect(args.from).toBe('2026-07-01');
    expect(args.to).toBe('2026-08-30');
    expect(args.includeThreads).toBe(true);
    expect(args.includeSystem).toBe(false);
    expect(args.includeBots).toBe(true);
  });

  it('#付きのチャンネル名でも指定できる', () => {
    const args = parseSlackExportArgs(['--channel=#general,#random'], CONTEXT_ARGS);
    expect(args.channels).toEqual(['general', 'random']);
  });

  it('IDと名前を混ぜられる', () => {
    const args = parseSlackExportArgs(['--channel=C0123ABCD,#general'], CONTEXT_ARGS);
    expect(args.channels).toEqual(['C0123ABCD', 'general']);
  });

  it('--channel も --all も無ければエラー', () => {
    expect(() => parseSlackExportArgs([], CONTEXT_ARGS)).toThrow(/--channel が指定されていません/);
  });

  it('--all と --channel の併用はエラー', () => {
    expect(() => parseSlackExportArgs(['--all', '--channel=C1234567'], CONTEXT_ARGS)).toThrow(
      /同時に指定できません/,
    );
  });

  it('--no-threads / --include-system / --no-bots', () => {
    const args = parseSlackExportArgs(
      ['--channel=C0123ABCD', '--no-threads', '--include-system', '--no-bots'],
      CONTEXT_ARGS,
    );
    expect(args.includeThreads).toBe(false);
    expect(args.includeSystem).toBe(true);
    expect(args.includeBots).toBe(false);
  });

  it('--page-limit は 1〜1000', () => {
    expect(parseSlackExportArgs(['--channel=C0123ABCD', '--page-limit=500'], CONTEXT_ARGS).pageLimit).toBe(500);
    expect(() => parseSlackExportArgs(['--channel=C0123ABCD', '--page-limit=1001'], CONTEXT_ARGS)).toThrow(
      /1〜1000/,
    );
  });

  it('期間の既定値は Chatwork 版と同じ', () => {
    const args = parseSlackExportArgs(['--channel=C0123ABCD'], CONTEXT_ARGS);
    expect(args.from).toBe('2026-08-01');
    expect(args.to).toBe('2026-08-30');
  });

  it('Chatwork 版のオプション名は受け付けない', () => {
    expect(() => parseSlackExportArgs(['--room=123'], CONTEXT_ARGS)).toThrow(ArgError);
  });

  it('--help はチャンネル未指定でも通る', () => {
    expect(parseSlackExportArgs(['--help'], CONTEXT_ARGS).help).toBe(true);
  });
});

describe('parseChannelRefs / isChannelId', () => {
  it('大文字のIDはIDとして扱う', () => {
    expect(parseChannelRefs(['C0123ABCD'])).toEqual(['C0123ABCD']);
  });

  it('チャンネル名は小文字に揃える（Slack の名前は小文字のみ）', () => {
    expect(parseChannelRefs(['#General'])).toEqual(['general']);
  });

  it('"general" のような名前をIDと誤認しない', () => {
    expect(parseChannelRefs(['#general'])).toEqual(['general']);
    expect(isChannelId('GENERAL')).toBe(true); // 大文字ならIDの形
    expect(isChannelId('general')).toBe(false); // 小文字は名前
  });

  it('重複を取り除く', () => {
    expect(parseChannelRefs(['C0123ABCD,#general', 'C0123ABCD'])).toEqual(['C0123ABCD', 'general']);
  });

  it('チャンネルIDの形を判定する', () => {
    expect(isChannelId('C0123ABCD')).toBe(true);
    expect(isChannelId('G0123ABCD')).toBe(true);
    expect(isChannelId('D0123ABCD')).toBe(true);
    expect(isChannelId('general')).toBe(false);
    expect(isChannelId('C123')).toBe(false);
  });
});
