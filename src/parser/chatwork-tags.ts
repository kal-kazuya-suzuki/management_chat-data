/**
 * Chatwork 記法のパーサ。
 *
 * このプロジェクト単体で完結させるため、外部ライブラリにも他プロジェクトにも依存しない。
 *
 * 方針（README にも記載）:
 *   - 中身ごと除去するタグ … [qt]…[/qt] / [qtmeta …] / [To:…] / [rp …] / [toall]
 *                            [picon:…] / [piconname:…] / [dtext:…] / [hr] / [preview …] / [deleted]
 *     → 引用は「相手の文章」なので文体サンプルにはノイズになるため中身ごと落とす。
 *   - タグだけ除去して中身は残すタグ … [info] / [title] / [code] / [download:…]…[/download]
 *     → これらの中身は発言者自身の文章・情報なので残す。
 */

/** [To:12345] に続く表示名（「〜さん」）まで含めて拾うためのパターン。 */
const TO_TAG = /\[To:(\d+)\][ \t]*(?:[^\[\]\n]{0,60}?さん)?/g;
/** [rp aid=123 to=456-789] とその直後の「〜さん」 */
const RP_TAG = /\[rp\s+([^\]]*)\][ \t]*(?:[^\[\]\n]{0,60}?さん)?/gi;
const RP_FIRST = /\[rp\s+([^\]]*)\]/i;
const QTMETA_TAG = /\[qtmeta[^\]]*\]/gi;
const SELF_CLOSING_TAGS =
  /\[(?:hr|toall|deleted|picon:[^\]]*|piconname:[^\]]*|dtext:[^\]]*|preview\s[^\]]*|info\s[^\]]*)\]/gi;
/** 中身を残すタグの開閉 */
const KEEP_INNER_TAGS = /\[\/?(?:info|title|code)\]/gi;
const DOWNLOAD_TAG = /\[download:[^\]]*\]([\s\S]*?)\[\/download\]/gi;
/** 閉じタグを失った [download:...] の保険 */
const DOWNLOAD_OPEN_ONLY = /\[download:[^\]]*\]|\[\/download\]/gi;

/** [To:12345] で言及された account_id を出現順に返す（重複は除去）。 */
export function extractMentions(body: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/\[To:(\d+)\]/g)) {
    const id = match[1] as string;
    if (!seen.has(id)) {
      seen.add(id);
      found.push(id);
    }
  }
  return found;
}

export interface ReplyRef {
  /** 返信先の message_id */
  messageId: string;
  /** 返信先の room_id（to=<room_id>-<message_id> の左側） */
  roomId: string | null;
  /** 返信先の account_id（aid=） */
  accountId: string | null;
}

/** 先頭の [rp aid=... to=roomId-messageId] を解析する。無ければ null。 */
export function extractReplyTo(body: string): ReplyRef | null {
  const match = RP_FIRST.exec(body);
  if (!match) return null;

  const attrs = match[1] as string;
  const to = /\bto=([\w-]+)/i.exec(attrs);
  if (!to) return null;

  const rawTo = to[1] as string;
  const separator = rawTo.lastIndexOf('-');
  const roomId = separator > 0 ? rawTo.slice(0, separator) : null;
  const messageId = separator > 0 ? rawTo.slice(separator + 1) : rawTo;
  if (!messageId) return null;

  const aid = /\baid=(\d+)/i.exec(attrs);

  return {
    messageId,
    roomId,
    accountId: aid ? (aid[1] as string) : null,
  };
}

/**
 * [tag]…[/tag] を入れ子に対応して中身ごと取り除く。
 * 閉じタグが無い場合は開始タグだけを落として中身は残す（本文の消失を防ぐため）。
 */
export function removeBalancedBlock(text: string, tag: string): string {
  const open = `[${tag}]`;
  const close = `[/${tag}]`;
  let out = '';
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start === -1) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, start);

    let depth = 1;
    let scan = start + open.length;
    let end = -1;
    while (depth > 0) {
      const nextOpen = text.indexOf(open, scan);
      const nextClose = text.indexOf(close, scan);
      if (nextClose === -1) break; // 閉じタグ無し
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        scan = nextOpen + open.length;
      } else {
        depth -= 1;
        scan = nextClose + close.length;
        if (depth === 0) end = scan;
      }
    }

    if (end === -1) {
      // 閉じタグが見つからない壊れた記法。開始タグだけ除去して残りはそのまま扱う。
      out += text.slice(start + open.length);
      break;
    }
    cursor = end;
  }

  return out;
}

/** 空白の整形: 行末の空白を落とし、3行以上の連続改行を2行にまとめる。 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Chatwork 記法を取り除いたプレーンテキストを返す。 */
export function stripChatworkTags(body: string): string {
  if (!body) return '';

  let text = body.replace(/\r\n?/g, '\n');

  // 1. 引用は中身ごと除去（入れ子対応）
  text = removeBalancedBlock(text, 'qt');
  text = text.replace(QTMETA_TAG, '');

  // 2. 返信・宛先タグ（直後の「〜さん」も含めて除去）
  text = text.replace(RP_TAG, '');
  text = text.replace(TO_TAG, '');

  // 3. 中身を残すタグ: [download:...]ファイル名[/download] → ファイル名
  text = text.replace(DOWNLOAD_TAG, '$1');
  text = text.replace(DOWNLOAD_OPEN_ONLY, '');

  // 4. 単独タグ
  text = text.replace(SELF_CLOSING_TAGS, '');

  // 5. [info] / [title] / [code] はタグだけ落として中身を残す
  text = text.replace(KEEP_INNER_TAGS, '\n');

  return normalizeWhitespace(text);
}

/** 本文の1行要約（Markdown の返信表示などに使う）。 */
export function summarize(text: string, maxLength = 40): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, maxLength)}…`;
}
