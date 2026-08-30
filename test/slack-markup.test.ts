import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  extractMentions,
  stripSlackMarkup,
  summarize,
} from '../src/parser/slack-markup.js';

const USERS = new Map([
  ['U12345', '鈴木一也'],
  ['U67890', '田中花子'],
]);
const CHANNELS = new Map([['C11111', 'general']]);

describe('stripSlackMarkup', () => {
  it('ユーザーメンションを名前に置き換える', () => {
    expect(stripSlackMarkup('<@U12345> お疲れさまです', { userNames: USERS })).toBe(
      '@鈴木一也 お疲れさまです',
    );
  });

  it('名前が分からないメンションは表示名、それも無ければIDを使う', () => {
    expect(stripSlackMarkup('<@U99999|yamada> こんにちは')).toBe('@yamada こんにちは');
    expect(stripSlackMarkup('<@U99999> こんにちは')).toBe('@U99999 こんにちは');
  });

  it('チャンネルメンションを名前に置き換える', () => {
    expect(stripSlackMarkup('<#C11111> を見てください', { channelNames: CHANNELS })).toBe(
      '#general を見てください',
    );
    expect(stripSlackMarkup('<#C22222|random> へどうぞ')).toBe('#random へどうぞ');
  });

  it('@here / @channel を残す', () => {
    expect(stripSlackMarkup('<!here> 共有です')).toBe('@here 共有です');
    expect(stripSlackMarkup('<!channel>')).toBe('@channel');
  });

  it('ユーザーグループのメンションを扱う', () => {
    expect(stripSlackMarkup('<!subteam^S123|@dev> 確認お願いします')).toBe(
      '@dev 確認お願いします',
    );
  });

  it('リンクは表示テキストを優先して残す', () => {
    expect(stripSlackMarkup('詳細は <https://example.com/a|こちら> です')).toBe(
      '詳細は こちら です',
    );
  });

  it('表示テキストが無いリンクは URL を残す', () => {
    expect(stripSlackMarkup('<https://example.com/a>')).toBe('https://example.com/a');
  });

  it('表示テキストと URL が同じなら URL を1つだけ残す', () => {
    expect(stripSlackMarkup('<https://example.com|https://example.com>')).toBe(
      'https://example.com',
    );
  });

  it('mailto リンクはアドレスにする', () => {
    expect(stripSlackMarkup('<mailto:a@example.com|a@example.com>')).toBe('a@example.com');
  });

  it('HTML エンティティを戻す', () => {
    expect(stripSlackMarkup('A &amp; B &lt;tag&gt;')).toBe('A & B <tag>');
  });

  it('装飾記号を外して中身を残す', () => {
    expect(stripSlackMarkup('*重要* な _お知らせ_ と ~取り消し~')).toBe(
      '重要 な お知らせ と 取り消し',
    );
  });

  it('コードブロック・インラインコードは中身を残す', () => {
    expect(stripSlackMarkup('```npm run export```')).toBe('npm run export');
    expect(stripSlackMarkup('`--mine` を付けます')).toBe('--mine を付けます');
  });

  it('単語の途中のアンダースコアは装飾扱いしない', () => {
    expect(stripSlackMarkup('snake_case_name をご確認ください')).toBe(
      'snake_case_name をご確認ください',
    );
  });

  it('掛け算やファイル名の記号を壊さない', () => {
    expect(stripSlackMarkup('2 * 3 = 6')).toBe('2 * 3 = 6');
  });

  it('絵文字ショートコードは書き方の一部なので残す', () => {
    expect(stripSlackMarkup('ありがとうございます :bow:')).toBe('ありがとうございます :bow:');
  });

  it('3行以上の連続改行を2行にまとめ、前後の空白を落とす', () => {
    expect(stripSlackMarkup('\n\n一行目   \n\n\n\n二行目\n\n')).toBe('一行目\n\n二行目');
  });

  it('空文字は空文字のまま', () => {
    expect(stripSlackMarkup('')).toBe('');
  });

  it('複合的な本文をまとめて処理する', () => {
    const text =
      '<@U12345> <@U67890>\n*本日中* に <https://docs.example.com/spec|仕様書> を確認して、' +
      '<#C11111|general> へ &lt;返信&gt; お願いします :pray:';
    expect(stripSlackMarkup(text, { userNames: USERS, channelNames: CHANNELS })).toBe(
      '@鈴木一也 @田中花子\n本日中 に 仕様書 を確認して、#general へ <返信> お願いします :pray:',
    );
  });
});

describe('extractMentions', () => {
  it('user_id を出現順に返す', () => {
    expect(extractMentions('<@U12345> と <@U67890|花子> よろしく')).toEqual(['U12345', 'U67890']);
  });

  it('重複は取り除く', () => {
    expect(extractMentions('<@U12345> <@U12345>')).toEqual(['U12345']);
  });

  it('メンションが無ければ空配列', () => {
    expect(extractMentions('ただのテキスト')).toEqual([]);
  });

  it('チャンネルメンションは拾わない', () => {
    expect(extractMentions('<#C11111|general>')).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('&amp; を最後に戻して二重変換を避ける', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('summarize', () => {
  it('長い本文は省略記号を付けて切り詰める', () => {
    expect(summarize('あ'.repeat(50), 10)).toBe(`${'あ'.repeat(10)}…`);
  });
});
