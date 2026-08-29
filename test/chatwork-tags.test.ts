import { describe, expect, it } from 'vitest';
import {
  extractMentions,
  extractReplyTo,
  removeBalancedBlock,
  stripChatworkTags,
  summarize,
} from '../src/parser/chatwork-tags.js';

describe('stripChatworkTags', () => {
  it('宛先タグ [To:12345] を除去する', () => {
    expect(stripChatworkTags('[To:12345]\nお疲れさまです。')).toBe('お疲れさまです。');
  });

  it('[To:12345] に続く「〜さん」も一緒に除去する', () => {
    expect(stripChatworkTags('[To:12345] 山田太郎さん\n確認しました。')).toBe('確認しました。');
  });

  it('姓名の間に空白がある表示名でも除去する', () => {
    expect(stripChatworkTags('[To:12345] 山田 太郎さん\nよろしくお願いします。')).toBe(
      'よろしくお願いします。',
    );
  });

  it('複数の宛先をまとめて除去する', () => {
    const body = '[To:111] 山田さん\n[To:222] 田中さん\n本日の件です。';
    expect(stripChatworkTags(body)).toBe('本日の件です。');
  });

  it('本文中の「〜さん」は残す', () => {
    expect(stripChatworkTags('[To:12345] 山田さん\n田中さんにも共有しました。')).toBe(
      '田中さんにも共有しました。',
    );
  });

  it('返信タグ [rp] とその後ろの名前を除去する', () => {
    const body = '[rp aid=1234567 to=98765432-1234567890] 山田太郎さん\n承知しました。';
    expect(stripChatworkTags(body)).toBe('承知しました。');
  });

  it('引用 [qt][qtmeta ...]...[/qt] は中身ごと除去する', () => {
    const body = '[qt][qtmeta aid=1234567 time=1754006400]明日の打ち合わせは10時からです[/qt]\n了解です、10時に伺います。';
    expect(stripChatworkTags(body)).toBe('了解です、10時に伺います。');
  });

  it('入れ子になった引用も正しく除去する', () => {
    const body = '[qt][qtmeta aid=1 time=2]外側[qt][qtmeta aid=3 time=4]内側[/qt]まだ外側[/qt]本文';
    expect(stripChatworkTags(body)).toBe('本文');
  });

  it('[info][title]...[/title]...[/info] は中身を残す', () => {
    const body = '[info][title]今週の予定[/title]月曜: 定例\n火曜: 訪問[/info]';
    expect(stripChatworkTags(body)).toBe('今週の予定\n月曜: 定例\n火曜: 訪問');
  });

  it('[code] は中身を残す', () => {
    expect(stripChatworkTags('[code]npm run export[/code]')).toBe('npm run export');
  });

  it('[hr] / [picon:...] / [dtext:...] / [toall] を除去する', () => {
    const body = '[toall]\n[picon:1234567]おはようございます\n[hr]\n[dtext:chatroom_chat_edited]';
    expect(stripChatworkTags(body)).toBe('おはようございます');
  });

  it('[download:...]ファイル名[/download] はファイル名を残す', () => {
    const body = '資料です\n[download:1234567]見積書_202608.pdf[/download]';
    expect(stripChatworkTags(body)).toBe('資料です\n見積書_202608.pdf');
  });

  it('複合的な本文をまとめて処理する', () => {
    const body = [
      '[rp aid=1111 to=2222-3333] 山田太郎さん',
      '[qt][qtmeta aid=1111 time=1754006400]金額の確認をお願いします[/qt]',
      'ご確認ありがとうございます。',
      '[info][title]修正点[/title]単価を 1,200 円に変更しました[/info]',
      '[download:44444]見積書_v2.pdf[/download]',
    ].join('\n');

    expect(stripChatworkTags(body)).toBe(
      // [info] ブロックは前後に空行が入り、読みやすさのため段落として分かれる
      [
        'ご確認ありがとうございます。',
        '',
        '修正点',
        '単価を 1,200 円に変更しました',
        '',
        '見積書_v2.pdf',
      ].join('\n'),
    );
  });

  it('3行以上の連続改行を2行にまとめ、前後の空白を落とす', () => {
    expect(stripChatworkTags('\n\n一行目   \n\n\n\n二行目\n\n')).toBe('一行目\n\n二行目');
  });

  it('CRLF を LF に正規化する', () => {
    expect(stripChatworkTags('一行目\r\n二行目')).toBe('一行目\n二行目');
  });

  it('タグしか無い本文は空文字になる', () => {
    expect(stripChatworkTags('[To:12345]')).toBe('');
  });

  it('空文字や記法を含まない本文はそのまま', () => {
    expect(stripChatworkTags('')).toBe('');
    expect(stripChatworkTags('ただのテキスト')).toBe('ただのテキスト');
  });

  it('角括弧を含む通常の文章は壊さない', () => {
    expect(stripChatworkTags('[重要] 明日の件')).toBe('[重要] 明日の件');
  });
});

describe('removeBalancedBlock', () => {
  it('閉じタグが無い場合は開始タグだけ落として中身を残す', () => {
    expect(removeBalancedBlock('前[qt]壊れた引用', 'qt')).toBe('前壊れた引用');
  });

  it('同じタグが複数あってもすべて処理する', () => {
    expect(removeBalancedBlock('a[qt]1[/qt]b[qt]2[/qt]c', 'qt')).toBe('abc');
  });
});

describe('extractMentions', () => {
  it('[To:] の account_id を出現順に返す', () => {
    expect(extractMentions('[To:111] A さん\n[To:222] B さん\n本文')).toEqual(['111', '222']);
  });

  it('重複は取り除く', () => {
    expect(extractMentions('[To:111][To:111][To:222]')).toEqual(['111', '222']);
  });

  it('メンションが無ければ空配列', () => {
    expect(extractMentions('ただのテキスト')).toEqual([]);
  });
});

describe('extractReplyTo', () => {
  it('to=<room_id>-<message_id> から message_id を取り出す', () => {
    const reply = extractReplyTo('[rp aid=1234567 to=98765432-1122334455] 山田さん\n本文');
    expect(reply).toEqual({
      messageId: '1122334455',
      roomId: '98765432',
      accountId: '1234567',
    });
  });

  it('最初の [rp] だけを見る', () => {
    const body = '[rp aid=1 to=10-100]\n[rp aid=2 to=20-200]';
    expect(extractReplyTo(body)?.messageId).toBe('100');
  });

  it('[rp] が無ければ null', () => {
    expect(extractReplyTo('本文のみ')).toBeNull();
  });

  it('to= が無い壊れた [rp] は null', () => {
    expect(extractReplyTo('[rp aid=1234567]')).toBeNull();
  });
});

describe('summarize', () => {
  it('長い本文は省略記号を付けて切り詰める', () => {
    expect(summarize('あ'.repeat(50), 10)).toBe(`${'あ'.repeat(10)}…`);
  });

  it('改行は空白に潰す', () => {
    expect(summarize('一行目\n二行目')).toBe('一行目 二行目');
  });
});
