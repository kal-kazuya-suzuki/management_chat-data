import { describe, expect, it } from 'vitest';
import {
  cleanEmailBody,
  splitQuotedReply,
  stripQuotedReply,
  stripSignature,
} from '../src/parser/email-cleanup.js';
import {
  collectAttachments,
  decodeBase64Url,
  decodeHtmlEntities,
  extractBody,
  findHeader,
  htmlToText,
  normalizeText,
  type MimePart,
} from '../src/parser/mime.js';

/** テスト用に base64url へ符号化する。 */
function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

describe('decodeBase64Url', () => {
  it('base64url をデコードする', () => {
    expect(decodeBase64Url(b64url('こんにちは'))).toBe('こんにちは');
  });

  it('パディングが無くてもデコードできる', () => {
    expect(decodeBase64Url(b64url('abc'))).toBe('abc');
    expect(decodeBase64Url(b64url('abcd'))).toBe('abcd');
  });

  it('- と _ を含む文字列を扱える', () => {
    const source = 'テスト???>>>';
    expect(decodeBase64Url(b64url(source))).toBe(source);
  });
});

describe('findHeader', () => {
  const part: MimePart = {
    headers: [
      { name: 'From', value: '山田太郎 <yamada@example.com>' },
      { name: 'Subject', value: '見積の件' },
    ],
  };

  it('大文字小文字を無視して引ける', () => {
    expect(findHeader(part, 'from')).toBe('山田太郎 <yamada@example.com>');
    expect(findHeader(part, 'SUBJECT')).toBe('見積の件');
  });

  it('無いヘッダは null', () => {
    expect(findHeader(part, 'Cc')).toBeNull();
    expect(findHeader(undefined, 'From')).toBeNull();
  });
});

describe('extractBody', () => {
  it('text/plain を優先する', () => {
    const payload: MimePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('平文の本文') } },
        { mimeType: 'text/html', body: { data: b64url('<p>HTMLの本文</p>') } },
      ],
    };
    expect(extractBody(payload)).toEqual({ text: '平文の本文', source: 'text/plain' });
  });

  it('text/plain が無ければ text/html を平文化する', () => {
    const payload: MimePart = {
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<p>一行目</p><p>二行目</p>') } }],
    };
    // <p> は段落なので、間に空行が入る
    expect(extractBody(payload)).toEqual({ text: '一行目\n\n二行目', source: 'text/html' });
  });

  it('入れ子のマルチパートでも本文を見つける', () => {
    const payload: MimePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: b64url('本文です') } }],
        },
        { mimeType: 'application/pdf', filename: '見積書.pdf', body: { attachmentId: 'A1' } },
      ],
    };
    expect(extractBody(payload).text).toBe('本文です');
  });

  it('添付の text/plain は本文として扱わない', () => {
    const payload: MimePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('本文') } },
        {
          mimeType: 'text/plain',
          filename: 'log.txt',
          body: { data: b64url('添付の中身'), attachmentId: 'A1' },
        },
      ],
    };
    expect(extractBody(payload).text).toBe('本文');
  });

  it('パートを持たない単純なメールも読める', () => {
    expect(extractBody({ mimeType: 'text/plain', body: { data: b64url('単純な本文') } }).text).toBe(
      '単純な本文',
    );
  });

  it('本文が無ければ none', () => {
    expect(extractBody({ mimeType: 'multipart/mixed', parts: [] })).toEqual({
      text: '',
      source: 'none',
    });
  });
});

describe('collectAttachments', () => {
  it('添付ファイル名だけを集める', () => {
    const payload: MimePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('本文') } },
        { mimeType: 'application/pdf', filename: '見積書.pdf', body: { attachmentId: 'A1' } },
        { mimeType: 'image/png', filename: '図.png', body: { attachmentId: 'A2' } },
      ],
    };
    expect(collectAttachments(payload)).toEqual(['見積書.pdf', '図.png']);
  });

  it('attachmentId の無いパートは添付ではない', () => {
    const payload: MimePart = {
      parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64url('本文') } }],
    };
    expect(collectAttachments(payload)).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('script / style は中身ごと除去する', () => {
    expect(normalizeText(htmlToText('<style>p{color:red}</style><p>本文</p>'))).toBe('本文');
  });

  it('br と p を改行にする', () => {
    expect(normalizeText(htmlToText('一行目<br>二行目<p>三行目</p>'))).toBe('一行目\n二行目\n三行目');
  });

  it('タグを除去して中身を残す', () => {
    expect(htmlToText('<a href="https://example.com">リンク</a>')).toBe('リンク');
  });

  it('HTML コメントを除去する', () => {
    expect(htmlToText('<!-- 注釈 -->本文')).toBe('本文');
  });
});

describe('decodeHtmlEntities', () => {
  it('よく使う実体参照を戻す', () => {
    expect(decodeHtmlEntities('A &amp; B &lt;tag&gt; &quot;引用&quot;')).toBe('A & B <tag> "引用"');
  });

  it('数値文字参照を戻す', () => {
    expect(decodeHtmlEntities('&#26085;&#26412;')).toBe('日本');
    expect(decodeHtmlEntities('&#x65E5;')).toBe('日');
  });

  it('&amp;lt; は &lt; に戻す（二重変換しない）', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('stripQuotedReply', () => {
  it('引用記号 > から下を切り落とす', () => {
    const text = 'ご確認ありがとうございます。\n\n> 見積の件、いかがでしょうか\n> よろしくお願いします';
    expect(stripQuotedReply(text)).toBe('ご確認ありがとうございます。');
  });

  it('全角の引用記号にも対応する', () => {
    expect(stripQuotedReply('承知しました。\n\n＞ 元の本文')).toBe('承知しました。');
  });

  it('日本語の引用ヘッダから下を切る', () => {
    const text =
      '対応します。\n\n2026年8月30日(土) 10:00 山田太郎 <yamada@example.com>:\n元のメッセージ本文';
    expect(stripQuotedReply(text)).toBe('対応します。');
  });

  it('英語の "On ... wrote:" から下を切る', () => {
    const text = 'Thanks.\n\nOn Sat, Aug 30, 2026 at 10:00 AM Taro <t@example.com> wrote:\noriginal';
    expect(stripQuotedReply(text)).toBe('Thanks.');
  });

  it('折り返された "On ... wrote:" も検出する', () => {
    const text =
      'Thanks.\n\nOn Sat, Aug 30, 2026 at 10:00 AM Taro Yamada\n<taro@example.com>\nwrote:\noriginal';
    expect(stripQuotedReply(text)).toBe('Thanks.');
  });

  it('-----元のメッセージ----- から下を切る', () => {
    const text = '承知しました。\n\n-----元のメッセージ-----\n差出人: 山田';
    expect(stripQuotedReply(text)).toBe('承知しました。');
  });

  it('Outlook の区切り線から下を切る', () => {
    const text = '確認します。\n\n________________________________\nFrom: Yamada';
    expect(stripQuotedReply(text)).toBe('確認します。');
  });

  it('「〜さんは書きました:」から下を切る', () => {
    const text = 'ありがとうございます。\n\n山田太郎さんは書きました:\n元の本文';
    expect(stripQuotedReply(text)).toBe('ありがとうございます。');
  });

  it('引用が無ければそのまま返す', () => {
    const text = 'お世話になっております。\n本日はありがとうございました。';
    expect(stripQuotedReply(text)).toBe(text);
  });

  it('本文中の不等号は引用扱いしない', () => {
    const text = '条件は A > B です。\n以上、よろしくお願いします。';
    expect(stripQuotedReply(text)).toBe(text);
  });

  it('切り落とした引用も取り出せる', () => {
    const { body, quoted } = splitQuotedReply('返信です。\n\n> 元の本文');
    expect(body).toBe('返信です。');
    expect(quoted).toBe('> 元の本文');
  });
});

describe('stripSignature', () => {
  it('"-- " 区切りから下を切る', () => {
    const text = '本文です。\n\n-- \n山田太郎\n株式会社サンプル';
    expect(stripSignature(text)).toBe('本文です。');
  });

  it('区切り線のあとに署名らしさがあれば切る', () => {
    const text =
      '本日はありがとうございました。\n\n------------------------------\n株式会社サンプル 山田太郎\n〒100-0001 東京都千代田区\nTEL: 03-1234-5678';
    expect(stripSignature(text)).toBe('本日はありがとうございました。');
  });

  it('区切り線が無くても末尾の署名ブロックを切る', () => {
    const text =
      'よろしくお願いいたします。\n\n株式会社サンプル\n営業部 山田太郎\nTEL: 03-1234-5678\nE-mail: yamada@example.com';
    expect(stripSignature(text)).toBe('よろしくお願いいたします。');
  });

  it('署名の手がかりが無ければ切らない', () => {
    const text = 'よろしくお願いいたします。\n\n山田';
    expect(stripSignature(text)).toBe(text);
  });

  it('本文全体が署名扱いになる場合は切らない', () => {
    const text = '株式会社サンプル 山田太郎\nTEL: 03-1234-5678';
    expect(stripSignature(text)).toBe(text);
  });

  it('区切り線があっても署名らしさが無ければ切らない', () => {
    const text = '手順は以下です。\n\n------------------------------\n1. まず確認\n2. 次に実行';
    expect(stripSignature(text)).toBe(text);
  });
});

describe('cleanEmailBody', () => {
  it('引用と署名をまとめて取り除く', () => {
    const text = [
      'ご確認ありがとうございます。',
      '本日中に修正版をお送りします。',
      '',
      '-- ',
      '株式会社サンプル 山田太郎',
      'TEL: 03-1234-5678',
      '',
      '2026年8月30日(土) 10:00 田中花子 <tanaka@example.com>:',
      '> 見積の件、いかがでしょうか',
    ].join('\n');

    expect(cleanEmailBody(text)).toBe('ご確認ありがとうございます。\n本日中に修正版をお送りします。');
  });

  it('オプションで除去を止められる', () => {
    const text = '本文\n\n> 引用';
    expect(cleanEmailBody(text, { stripQuotes: false })).toBe('本文\n\n> 引用');
  });

  it('空文字は空文字のまま', () => {
    expect(cleanEmailBody('')).toBe('');
  });

  it('3行以上の連続改行を2行にまとめる', () => {
    expect(cleanEmailBody('一行目\n\n\n\n二行目')).toBe('一行目\n\n二行目');
  });
});
