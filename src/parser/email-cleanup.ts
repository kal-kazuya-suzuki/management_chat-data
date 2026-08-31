/**
 * メール本文から「引用返信」と「署名」を取り除く。
 *
 * 文体サンプルとして使う場合、ここが品質を一番左右する。
 *   - 引用を残すと、同じ文面が返信のたびに重複して混ざる
 *   - 署名を残すと、会社名・電話番号が全メールの末尾に付いてくる
 *
 * 方針は「確信が持てるときだけ切る」。
 * 本文を削りすぎるほうが、少し残るより害が大きいため、判定は保守的にしている。
 */

/** 引用の始まりを示す行のパターン。 */
const QUOTE_START_PATTERNS: RegExp[] = [
  // 引用記号そのもの
  /^\s*[>＞]/,
  // -----Original Message----- / -----元のメッセージ-----
  /^\s*-{2,}\s*(Original Message|元のメッセージ|転送メッセージ|Forwarded message)\s*-{2,}\s*$/i,
  // Outlook の区切り線
  /^_{10,}\s*$/,
  // 2026年8月30日(土) 10:00 山田太郎 <a@example.com>:
  /^\s*\d{4}年\s*\d{1,2}月\s*\d{1,2}日.*[:：]\s*$/,
  // 2026/08/30 10:00 山田太郎 <a@example.com>:
  /^\s*\d{4}\/\d{1,2}\/\d{1,2}.*<[^>]+@[^>]+>\s*[:：]\s*$/,
  // 山田太郎さんは書きました:
  /^.{0,60}さんは(次のように)?書きました[:：]?\s*$/,
  // Outlook 形式のヘッダブロック
  /^\s*(差出人|送信者|From)\s*[:：]\s*.+$/,
];

/** "On ... wrote:" は途中で改行されることがあるので、複数行をまとめて見る。 */
const EN_ATTRIBUTION_START = /^\s*On\s+.+/;
const EN_ATTRIBUTION_END = /wrote\s*[:：]\s*$/;

/** 署名の区切り線。 */
const SIGNATURE_SEPARATOR = /^\s*[-_=*~─━＝‾]{3,}\s*$/;
/** RFC 3676 の標準的な署名区切り（"-- " のみの行）。 */
const RFC_SIGNATURE_DELIMITER = /^--\s?$/;

/** これがあれば署名ブロックとみなす、強い手がかり。 */
const SIGNATURE_MARKERS: RegExp[] = [
  /〒\s*\d{3}/,
  /\bTEL\b\s*[:：]/i,
  /\bFAX\b\s*[:：]/i,
  /電話\s*[:：]/,
  /\bE-?mail\b\s*[:：]/i,
  /(株式会社|有限会社|合同会社|Inc\.|Co\.,\s*Ltd)/,
  /Mobile\s*[:：]/i,
];

export interface CleanupOptions {
  /** 引用返信を取り除く。既定 true */
  stripQuotes?: boolean;
  /** 署名を取り除く。既定 true */
  stripSignature?: boolean;
}

/** 本文と、切り落とした引用部分に分ける。 */
export function splitQuotedReply(text: string): { body: string; quoted: string } {
  const lines = text.split('\n');
  const cutAt = findQuoteStart(lines);
  if (cutAt === -1) return { body: text, quoted: '' };
  return {
    body: lines.slice(0, cutAt).join('\n').trimEnd(),
    quoted: lines.slice(cutAt).join('\n').trim(),
  };
}

/** 引用が始まる行番号を返す。見つからなければ -1。 */
function findQuoteStart(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;

    for (const pattern of QUOTE_START_PATTERNS) {
      if (pattern.test(line)) return i;
    }

    // "On Mon, Aug 30, 2026 at 10:00 山田太郎 <a@example.com> wrote:"
    // 途中で折り返されることがあるので、1〜3行つないだそれぞれで判定する
    // （まとめて3行つなぐと、1行で完結している場合に末尾が本文になってしまう）
    if (EN_ATTRIBUTION_START.test(line)) {
      for (let span = 1; span <= 3 && i + span <= lines.length; span += 1) {
        const window = lines.slice(i, i + span).join(' ').trimEnd();
        if (EN_ATTRIBUTION_END.test(window)) return i;
      }
    }
  }
  return -1;
}

export function stripQuotedReply(text: string): string {
  return splitQuotedReply(text).body;
}

/** 署名を取り除く。 */
export function stripSignature(text: string): string {
  const lines = text.split('\n');
  const cutAt = findSignatureStart(lines);
  if (cutAt === -1) return text;
  return lines.slice(0, cutAt).join('\n').trimEnd();
}

function hasSignatureMarker(text: string): boolean {
  return SIGNATURE_MARKERS.some((pattern) => pattern.test(text));
}

/** 署名が始まる行番号を返す。見つからなければ -1。 */
function findSignatureStart(lines: readonly string[]): number {
  // 1. "-- " の行があれば、そこが署名の始まり（最も確実）
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (RFC_SIGNATURE_DELIMITER.test(lines[i] as string)) return i;
  }

  // 2. 末尾近くの区切り線のあとに署名らしさがあれば、そこから切る
  const separatorSearchStart = Math.max(0, lines.length - 20);
  for (let i = lines.length - 1; i >= separatorSearchStart; i -= 1) {
    if (!SIGNATURE_SEPARATOR.test(lines[i] as string)) continue;
    const after = lines.slice(i + 1).join('\n');
    if (hasSignatureMarker(after)) return i;
  }

  // 3. 末尾の連続ブロックが署名の手がかりを含むなら、そのブロックごと切る
  //    （区切り線を使わない署名のため。誤爆を避けて末尾12行までに限定する）
  const blockSearchStart = Math.max(0, lines.length - 12);
  const tail = lines.slice(blockSearchStart).join('\n');
  if (!hasSignatureMarker(tail)) return -1;

  let markerLine = -1;
  for (let i = lines.length - 1; i >= blockSearchStart; i -= 1) {
    if (hasSignatureMarker(lines[i] as string)) {
      markerLine = i;
      break;
    }
  }
  if (markerLine === -1) return -1;

  // 手がかりのある行から上に遡り、空行に当たったところをブロックの先頭とする
  let start = markerLine;
  while (start > 0 && (lines[start - 1] as string).trim() !== '') {
    start -= 1;
  }
  // 本文全体が署名扱いになるのは明らかにおかしいので、その場合は切らない
  if (start === 0) return -1;
  return start;
}

/** 引用と署名を取り除いた本文を返す。 */
export function cleanEmailBody(text: string, options: CleanupOptions = {}): string {
  if (!text) return '';
  let out = text;
  if (options.stripQuotes !== false) out = stripQuotedReply(out);
  if (options.stripSignature !== false) out = stripSignature(out);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
