/**
 * Gmail API が返す MIME ペイロードから本文を取り出す。
 *
 * このプロジェクト単体で完結させるため、外部ライブラリには依存しない。
 *
 * Gmail の payload は入れ子の木構造で、
 *   multipart/alternative → [text/plain, text/html]
 *   multipart/mixed       → [multipart/alternative, application/pdf, ...]
 * のようになっている。text/plain があればそれを使い、無ければ text/html を平文化する。
 */

export interface MimePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: MimePart[];
}

/** base64url（Gmail は `-` `_` を使い、パディングを省く）をデコードする。 */
export function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/** ヘッダを名前で引く（大文字小文字は無視）。 */
export function findHeader(part: MimePart | undefined, name: string): string | null {
  if (!part?.headers) return null;
  const lower = name.toLowerCase();
  for (const header of part.headers) {
    if (header.name.toLowerCase() === lower) return header.value;
  }
  return null;
}

/** MIME の木を深さ優先で走査する。 */
export function* walkParts(part: MimePart | undefined): Generator<MimePart> {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) {
    yield* walkParts(child);
  }
}

/** 添付ファイル名の一覧（本文パートは除く）。 */
export function collectAttachments(payload: MimePart | undefined): string[] {
  const names: string[] = [];
  for (const part of walkParts(payload)) {
    const filename = part.filename?.trim();
    if (filename && part.body?.attachmentId) names.push(filename);
  }
  return names;
}

/** 指定した MIME タイプの本文をすべて集める（添付は除く）。 */
function collectByType(payload: MimePart | undefined, mimeType: string): string[] {
  const chunks: string[] = [];
  for (const part of walkParts(payload)) {
    if (part.mimeType !== mimeType) continue;
    // ファイル名が付いているものは添付なので本文として扱わない
    if (part.filename && part.filename.trim() !== '') continue;
    const data = part.body?.data;
    if (data) chunks.push(decodeBase64Url(data));
  }
  return chunks;
}

/** HTML を素朴に平文化する。整形の正確さより、読める・壊れないことを優先する。 */
export function htmlToText(html: string): string {
  let text = html;

  // 表示されない要素は中身ごと除去
  text = text.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // ブロック要素・改行を改行に置き換える（開始タグ・終了タグの両方）
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<(p|div|tr|li|h[1-6]|blockquote|table)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, '\n');
  text = text.replace(/<(hr)\s*\/?>/gi, '\n---\n');
  text = text.replace(/<\/(td|th)>/gi, '\t');

  // 残りのタグを除去
  text = text.replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(text);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  yen: '¥',
  middot: '・',
  hellip: '…',
  mdash: '—',
  ndash: '–',
};

export function decodeHtmlEntities(text: string): string {
  return (
    text
      .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) =>
        String.fromCodePoint(Number.parseInt(hex, 16)),
      )
      .replace(/&#(\d+);/g, (_all, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&([a-z]+);/gi, (all, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? all)
      // &amp; は最後に戻さないと二重変換になる
      .replace(/&amp;/g, '&')
  );
}

/** 行末の空白を落とし、3行以上の連続改行を2行にまとめる。 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t　]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ExtractedBody {
  text: string;
  /** text/plain から取れたか、HTML を平文化したか */
  source: 'text/plain' | 'text/html' | 'none';
}

/** payload から本文を取り出す。text/plain を優先し、無ければ text/html を平文化する。 */
export function extractBody(payload: MimePart | undefined): ExtractedBody {
  const plain = collectByType(payload, 'text/plain');
  if (plain.length > 0) {
    const text = normalizeText(plain.join('\n'));
    if (text !== '') return { text, source: 'text/plain' };
  }

  const html = collectByType(payload, 'text/html');
  if (html.length > 0) {
    const text = normalizeText(htmlToText(html.join('\n')));
    if (text !== '') return { text, source: 'text/html' };
  }

  // パートを持たない単純なメール
  const data = payload?.body?.data;
  if (data) {
    const raw = decodeBase64Url(data);
    const text =
      payload?.mimeType === 'text/html' ? normalizeText(htmlToText(raw)) : normalizeText(raw);
    if (text !== '') {
      return { text, source: payload?.mimeType === 'text/html' ? 'text/html' : 'text/plain' };
    }
  }

  return { text: '', source: 'none' };
}
