import { describe, expect, it } from 'vitest';
import { MemberDirectory } from '../src/chatwork/members.js';
import { buildFileName, sanitizeForFilename } from '../src/output/files.js';
import {
  buildMineBlocks,
  filterMine,
  isoToDisplay,
  renderMarkdown,
  renderMineMarkdown,
  type MarkdownContext,
} from '../src/output/markdown.js';
import { toExportedMessage, type ExportedMessage } from '../src/output/record.js';
import type { ChatworkMember, ChatworkMessage } from '../src/chatwork/types.js';

const JST = 540;

function makeMessage(overrides: Partial<ExportedMessage> = {}): ExportedMessage {
  return {
    message_id: '1000',
    room_id: '999',
    room_name: 'テストルーム',
    account_id: '111',
    account_name: '山田太郎',
    body: '本文',
    body_plain: '本文',
    send_time: '2026-08-01T10:00:00+09:00',
    update_time: null,
    reply_to: null,
    mentions: [],
    ...overrides,
  };
}

const CONTEXT: MarkdownContext = {
  roomId: '999',
  roomName: 'テストルーム',
  from: '2026-08-01',
  to: '2026-08-29',
  tzLabel: '+09:00',
  generatedAt: '2026-08-29T22:00:00+09:00',
};

describe('toExportedMessage', () => {
  const members: ChatworkMember[] = [
    { account_id: 111, role: 'admin', name: '山田太郎' },
    { account_id: 222, role: 'member', name: '田中花子' },
  ];

  async function makeDirectory(): Promise<MemberDirectory> {
    const directory = new MemberDirectory({ getRoomMembers: async () => members });
    await directory.load('999');
    return directory;
  }

  it('API のメッセージを出力レコードに変換する', async () => {
    const directory = await makeDirectory();
    const raw: ChatworkMessage = {
      message_id: '1234567890',
      account: { account_id: 222, name: '古い表示名' },
      body: '[To:111] 山田太郎さん\n[qt][qtmeta aid=111 time=1]見積の件[/qt]\n了解しました。',
      send_time: 1_785_542_400, // 2026-08-01T00:00:00Z
      update_time: 1_785_546_000,
    };

    const record = toExportedMessage(raw, {
      roomId: '999',
      roomName: 'テストルーム',
      directory,
      tzOffsetMinutes: JST,
    });

    expect(record).toEqual({
      message_id: '1234567890',
      room_id: '999',
      room_name: 'テストルーム',
      account_id: '222',
      // 表示名はメンバー API の値を優先する
      account_name: '田中花子',
      body: raw.body,
      body_plain: '了解しました。',
      send_time: '2026-08-01T09:00:00+09:00',
      update_time: '2026-08-01T10:00:00+09:00',
      reply_to: null,
      mentions: ['111'],
    });
  });

  it('update_time が 0 なら null になる', async () => {
    const directory = await makeDirectory();
    const record = toExportedMessage(
      {
        message_id: '1',
        account: { account_id: 111, name: '山田太郎' },
        body: 'こんにちは',
        send_time: 1_785_542_400,
        update_time: 0,
      },
      { roomId: '999', roomName: 'テストルーム', directory, tzOffsetMinutes: JST },
    );
    expect(record.update_time).toBeNull();
  });

  it('[rp] があれば reply_to に参照先 message_id が入る', async () => {
    const directory = await makeDirectory();
    const record = toExportedMessage(
      {
        message_id: '2',
        account: { account_id: 111, name: '山田太郎' },
        body: '[rp aid=222 to=999-1234567890] 田中花子さん\n承知しました。',
        send_time: 1_785_542_400,
        update_time: 0,
      },
      { roomId: '999', roomName: 'テストルーム', directory, tzOffsetMinutes: JST },
    );
    expect(record.reply_to).toBe('1234567890');
    expect(record.body_plain).toBe('承知しました。');
  });

  it('メンバーに居ない account_id はメッセージ側の名前で補う', async () => {
    const directory = await makeDirectory();
    const record = toExportedMessage(
      {
        message_id: '3',
        account: { account_id: 999, name: '退室したユーザー' },
        body: 'テスト',
        send_time: 1_785_542_400,
        update_time: 0,
      },
      { roomId: '999', roomName: 'テストルーム', directory, tzOffsetMinutes: JST },
    );
    expect(record.account_name).toBe('退室したユーザー');
  });
});

describe('MemberDirectory', () => {
  it('同じルームのメンバーは1回しか取得しない', async () => {
    let calls = 0;
    const directory = new MemberDirectory({
      getRoomMembers: async () => {
        calls += 1;
        return [{ account_id: 111, role: 'member', name: '山田太郎' }];
      },
    });

    await directory.load('999');
    await directory.load('999');
    await directory.load('999');

    expect(calls).toBe(1);
    expect(directory.resolve('111', '999')).toBe('山田太郎');
  });

  it('別ルームで覚えた名前も引ける', async () => {
    const directory = new MemberDirectory({
      getRoomMembers: async (roomId) =>
        roomId === 'A'
          ? [{ account_id: 111, role: 'member', name: '山田太郎' }]
          : [{ account_id: 222, role: 'member', name: '田中花子' }],
    });

    await directory.load('A');
    await directory.load('B');

    expect(directory.resolve('111', 'B')).toBe('山田太郎');
  });

  it('未知の account_id は識別できる形で返す', () => {
    const directory = new MemberDirectory({ getRoomMembers: async () => [] });
    expect(directory.resolve('12345')).toBe('(account_id:12345)');
  });
});

describe('isoToDisplay', () => {
  it('ISO8601 から日時表記を作る', () => {
    expect(isoToDisplay('2026-08-01T10:12:33+09:00')).toBe('2026-08-01 10:12');
  });
});

describe('renderMarkdown', () => {
  it('ヘッダに ルーム名 / room_id / 期間 / 件数 を出す', () => {
    const md = renderMarkdown([makeMessage()], CONTEXT);
    expect(md).toContain('# テストルーム');
    expect(md).toContain('- room_id: 999');
    expect(md).toContain('- 期間: 2026-08-01 〜 2026-08-29 (+09:00)');
    expect(md).toContain('- 件数: 1');
  });

  it('取り扱い注意の注記を必ず入れる', () => {
    expect(renderMarkdown([], CONTEXT)).toContain('取り扱い注意');
  });

  it('「日時 発言者: 本文」の形式で時系列に並べる', () => {
    const md = renderMarkdown(
      [
        makeMessage({ message_id: '1', send_time: '2026-08-01T10:00:00+09:00', body_plain: 'おはようございます' }),
        makeMessage({
          message_id: '2',
          account_name: '田中花子',
          send_time: '2026-08-01T10:05:00+09:00',
          body_plain: 'よろしくお願いします',
        }),
      ],
      CONTEXT,
    );

    expect(md).toContain('**2026-08-01 10:00 山田太郎:**\nおはようございます');
    expect(md).toContain('**2026-08-01 10:05 田中花子:**\nよろしくお願いします');
    expect(md.indexOf('おはようございます')).toBeLessThan(md.indexOf('よろしくお願いします'));
  });

  it('[rp] は「○○さんの発言への返信」として表す', () => {
    const md = renderMarkdown([makeMessage({ message_id: '2', reply_to: '1' })], {
      ...CONTEXT,
      replyNames: new Map([['2', '田中花子']]),
    });
    expect(md).toContain('> 田中花子さんの発言への返信');
  });

  it('返信先の発言者が分からない場合も返信であることは示す', () => {
    const md = renderMarkdown([makeMessage({ message_id: '2', reply_to: '1' })], {
      ...CONTEXT,
      replyNames: new Map([['2', null]]),
    });
    expect(md).toContain('> 過去の発言への返信');
  });

  it('本文が空（ファイル送信など）でも行が消えない', () => {
    const md = renderMarkdown([makeMessage({ body_plain: '' })], CONTEXT);
    expect(md).toContain('（本文なし');
  });

  it('該当なしのときはその旨を書く', () => {
    expect(renderMarkdown([], CONTEXT)).toContain('該当するメッセージはありませんでした');
  });

  it('取得の警告があれば Markdown にも残す', () => {
    const md = renderMarkdown([], { ...CONTEXT, warnings: ['最大ページ数に達しました'] });
    expect(md).toContain('取得に関する警告');
    expect(md).toContain('最大ページ数に達しました');
  });
});

describe('buildMineBlocks / renderMineMarkdown', () => {
  const ME = '111';
  const timeline = [
    makeMessage({ message_id: '1', account_id: '222', account_name: '田中花子', body_plain: '見積もりの件、いかがでしょうか。' }),
    makeMessage({ message_id: '2', account_id: ME, body_plain: '本日中にお送りします。少々お待ちください。' }),
    makeMessage({ message_id: '3', account_id: ME, body_plain: '了解です' }),
    makeMessage({ message_id: '4', account_id: '222', account_name: '田中花子', body_plain: 'ありがとうございます。' }),
    makeMessage({ message_id: '5', account_id: ME, body_plain: 'それでは明日の10時にお伺いします。よろしくお願いいたします。' }),
  ];

  it('直前の相手の発言と自分の発言をセットにする', () => {
    const blocks = buildMineBlocks(timeline, { myAccountId: ME, minLength: 0 });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.partner?.message_id).toBe('1');
    expect(blocks[0]?.mine.map((m) => m.message_id)).toEqual(['2', '3']);
    expect(blocks[1]?.partner?.message_id).toBe('4');
    expect(blocks[1]?.mine.map((m) => m.message_id)).toEqual(['5']);
  });

  it('min-length 未満の短い発言を除外する', () => {
    const blocks = buildMineBlocks(timeline, { myAccountId: ME, minLength: 20 });
    // 「了解です」(4文字) は落ちる
    expect(blocks[0]?.mine.map((m) => m.message_id)).toEqual(['2']);
  });

  it('自分の発言が全部除外されたブロックは出力しない', () => {
    const shortOnly = [
      makeMessage({ message_id: '1', account_id: '222', body_plain: 'よろしく' }),
      makeMessage({ message_id: '2', account_id: ME, body_plain: '了解です' }),
    ];
    expect(buildMineBlocks(shortOnly, { myAccountId: ME, minLength: 20 })).toEqual([]);
  });

  it('先頭が自分の発言なら「直前の相手の発言なし」になる', () => {
    const blocks = buildMineBlocks(
      [makeMessage({ message_id: '1', account_id: ME, body_plain: 'おはようございます。本日もよろしくお願いします。' })],
      { myAccountId: ME, minLength: 0 },
    );
    expect(blocks[0]?.partner).toBeNull();
  });

  it('Markdown に相手の発言を引用として併記する', () => {
    const md = renderMineMarkdown(timeline, CONTEXT, { myAccountId: ME, minLength: 20 });

    expect(md).toContain('自分の発言（文体サンプル）');
    expect(md).toContain(`- 自分の account_id: ${ME}`);
    expect(md).toContain('**相手 / 2026-08-01 10:00 田中花子:**');
    expect(md).toContain('> 見積もりの件、いかがでしょうか。');
    expect(md).toContain('**自分 / 2026-08-01 10:00:**');
    expect(md).toContain('本日中にお送りします。少々お待ちください。');
    // 短い発言は出力されない
    expect(md).not.toContain('了解です');
  });

  it('相手の発言が無い場合も明示する', () => {
    const md = renderMineMarkdown(
      [makeMessage({ account_id: ME, body_plain: 'あ'.repeat(30) })],
      CONTEXT,
      { myAccountId: ME, minLength: 20 },
    );
    expect(md).toContain('（直前の相手の発言なし）');
  });

  it('該当なしのときはその旨を書く', () => {
    const md = renderMineMarkdown([], CONTEXT, { myAccountId: ME, minLength: 20 });
    expect(md).toContain('該当する自分の発言はありませんでした');
  });
});

describe('filterMine', () => {
  const ME = '111';

  it('自分の発言のうち min-length 以上のものだけ残す', () => {
    const result = filterMine(
      [
        makeMessage({ message_id: '1', account_id: '222', body_plain: 'あ'.repeat(30) }),
        makeMessage({ message_id: '2', account_id: ME, body_plain: 'あ'.repeat(30) }),
        makeMessage({ message_id: '3', account_id: ME, body_plain: '了解です' }),
      ],
      { myAccountId: ME, minLength: 20 },
    );
    expect(result.map((m) => m.message_id)).toEqual(['2']);
  });

  it('min-length=0 ならすべての自分の発言を残す', () => {
    const result = filterMine(
      [
        makeMessage({ message_id: '1', account_id: ME, body_plain: '' }),
        makeMessage({ message_id: '2', account_id: ME, body_plain: 'はい' }),
      ],
      { myAccountId: ME, minLength: 0 },
    );
    expect(result).toHaveLength(2);
  });
});

describe('ファイル名', () => {
  it('ルームIDと期間を含む', () => {
    const name = buildFileName({
      roomId: '123456789',
      roomName: 'サンプル株式会社',
      from: '2026-08-01',
      to: '2026-08-29',
      mine: false,
      extension: 'json',
    });
    expect(name).toBe('chatwork_123456789_サンプル株式会社_2026-08-01_2026-08-29.json');
  });

  it('--mine のときは mine が付く', () => {
    const name = buildFileName({
      roomId: '1',
      roomName: 'room',
      from: '2026-08-01',
      to: '2026-08-29',
      mine: true,
      extension: 'md',
    });
    expect(name).toBe('chatwork_1_room_2026-08-01_2026-08-29_mine.md');
  });

  it('ファイル名に使えない文字を落とす', () => {
    expect(sanitizeForFilename('A/B:C*D?E"F<G>H|I')).toBe('ABCDEFGHI');
    // 空白は半角・全角ともアンダースコアに置き換える
    expect(sanitizeForFilename('株式会社 サンプル')).toBe('株式会社_サンプル');
  });

  it('長すぎるルーム名は切り詰める', () => {
    expect(sanitizeForFilename('あ'.repeat(100)).length).toBe(40);
  });

  it('記号だけのルーム名でもファイル名が壊れない', () => {
    expect(sanitizeForFilename('///')).toBe('room');
  });
});
