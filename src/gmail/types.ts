/** Gmail API v1 のレスポンス型（このプロジェクトで使う範囲のみ）。 */
import type { MimePart } from '../parser/mime.js';

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** 受信時刻（ミリ秒の文字列） */
  internalDate?: string;
  payload?: MimePart;
  sizeEstimate?: number;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messagesTotal?: number;
  threadsTotal?: number;
}

export interface GmailLabelsResponse {
  labels?: GmailLabel[];
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

export interface ParsedAddress {
  /** 表示名。無ければ null */
  name: string | null;
  /** メールアドレス（小文字化） */
  email: string;
}

/**
 * `山田太郎 <yamada@example.com>, "田中, 花子" <tanaka@example.com>` のような
 * アドレスヘッダを分解する。
 * 表示名に含まれるカンマで壊れないよう、引用符と山括弧の内側は区切りとして扱わない。
 */
export function parseAddressList(header: string | null): ParsedAddress[] {
  if (!header) return [];

  const chunks: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (const char of header) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === '<') inAngle = true;
    if (char === '>') inAngle = false;
    if (char === ',' && !inQuotes && !inAngle) {
      chunks.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') chunks.push(current);

  const addresses: ParsedAddress[] = [];
  for (const chunk of chunks) {
    const parsed = parseAddress(chunk);
    if (parsed) addresses.push(parsed);
  }
  return addresses;
}

/** 単一のアドレスを分解する。 */
export function parseAddress(input: string): ParsedAddress | null {
  const raw = input.trim();
  if (raw === '') return null;

  const angle = /^(.*?)<([^>]+)>\s*$/.exec(raw);
  if (angle) {
    const name = (angle[1] as string).trim().replace(/^"(.*)"$/, '$1').trim();
    return { name: name === '' ? null : name, email: (angle[2] as string).trim().toLowerCase() };
  }

  if (raw.includes('@')) return { name: null, email: raw.toLowerCase() };
  return null;
}

/** 表示用の名前（表示名が無ければアドレスのローカル部）。 */
export function displayNameOf(address: ParsedAddress | null): string {
  if (!address) return '(不明な送信者)';
  if (address.name) return address.name;
  const at = address.email.indexOf('@');
  return at > 0 ? address.email.slice(0, at) : address.email;
}

/** 件名の `Re:` / `Fwd:` を取り除く（スレッド名として使うため）。 */
export function normalizeSubject(subject: string | null): string {
  if (!subject) return '(件名なし)';
  const stripped = subject.replace(/^\s*((re|fwd?|返信|転送)\s*[:：]\s*)+/i, '').trim();
  return stripped === '' ? '(件名なし)' : stripped;
}
