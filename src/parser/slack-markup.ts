/**
 * Slack の mrkdwn 記法のパーサ。
 *
 * このプロジェクト単体で完結させるため、外部ライブラリにも他プロジェクトにも依存しない。
 *
 * 方針（Chatwork 版と揃えている）:
 *   - ID を人間が読める名前に置き換える … <@U123> / <#C123|general> / <!subteam^S1|@team>
 *   - リンクは表示テキストを優先して残す … <https://example.com|詳細> → 詳細
 *   - 装飾記号は外して中身を残す … *太字* / _斜体_ / ~取り消し~ / `code` / ```block```
 *   - 絵文字ショートコード（:smile:）は「その人の書き方」の一部なので残す
 */

/** <@U12345> / <@U12345|表示名> */
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;
/** <#C12345> / <#C12345|general> */
const CHANNEL_MENTION = /<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g;
/** <!subteam^S12345|@team> */
const SUBTEAM_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g;
/** <!here> / <!channel> / <!everyone> / <!date^...|表示> */
const SPECIAL_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const DATE_TOKEN = /<!date\^\d+\^[^>|]*(?:\|([^>]*))?>/g;
/** <https://example.com|表示テキスト> / <mailto:a@b.com|a@b.com> */
const LINK = /<((?:https?|mailto|tel):[^>|]*)(?:\|([^>]*))?>/g;

export interface SlackMarkupOptions {
  /** user_id → 表示名。渡すとメンションを実名に置き換える */
  userNames?: Map<string, string>;
  /** channel_id → チャンネル名 */
  channelNames?: Map<string, string>;
}

/** <@U12345> の user_id を出現順に返す（重複は除去）。 */
export function extractMentions(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    const id = match[1] as string;
    if (!seen.has(id)) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

/** Slack が使う HTML エンティティを戻す。&amp; は最後に戻さないと二重変換になる。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 装飾記号（*太字* _斜体_ ~取り消し~ `code`）を外して中身を残す。 */
function stripDecorations(text: string): string {
  return (
    text
      // ```コードブロック``` は中身を残す
      .replace(/```([\s\S]*?)```/g, '$1')
      // `インラインコード`
      .replace(/`([^`\n]+)`/g, '$1')
      // *太字* / _斜体_ / ~取り消し線~
      // 記号の内側が空でなく、記号の外が単語文字でない場合だけ装飾とみなす
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2')
      .replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, '$1$2')
      .replace(/(^|[^\w~])~([^~\n]+)~(?=[^\w~]|$)/g, '$1$2')
  );
}

/** 引用記号 "&gt; " を Markdown の引用として残しつつ、行頭の余分な空白を整える。 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Slack の mrkdwn をプレーンテキストにする。 */
export function stripSlackMarkup(text: string, options: SlackMarkupOptions = {}): string {
  if (!text) return '';

  let out = text.replace(/\r\n?/g, '\n');

  // 1. メンション類を読める形に
  out = out.replace(USER_MENTION, (_all, id: string, label?: string) => {
    const name = options.userNames?.get(id) ?? label ?? null;
    return name ? `@${name}` : `@${id}`;
  });
  out = out.replace(CHANNEL_MENTION, (_all, id: string, label?: string) => {
    const name = options.channelNames?.get(id) ?? label ?? null;
    return name ? `#${name}` : `#${id}`;
  });
  out = out.replace(SUBTEAM_MENTION, (_all, id: string, label?: string) =>
    label ? (label.startsWith('@') ? label : `@${label}`) : `@${id}`,
  );
  out = out.replace(SPECIAL_MENTION, (_all, keyword: string) => `@${keyword}`);
  out = out.replace(DATE_TOKEN, (_all, fallback?: string) => fallback ?? '');

  // 2. リンクは表示テキストを優先（無ければ URL 自体を残す）
  out = out.replace(LINK, (_all, url: string, label?: string) => {
    if (!label) return url.replace(/^mailto:/, '');
    const plainLabel = label.trim();
    const plainUrl = url.replace(/^mailto:/, '');
    // 表示テキストが URL と同じなら片方だけ
    return plainLabel === plainUrl || plainLabel === '' ? plainUrl : plainLabel;
  });

  // 3. エンティティを戻してから装飾を外す
  out = decodeEntities(out);
  out = stripDecorations(out);

  return normalizeWhitespace(out);
}

/** 本文の1行要約（Markdown の返信表示などに使う）。 */
export function summarize(text: string, maxLength = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, maxLength)}…`;
}
