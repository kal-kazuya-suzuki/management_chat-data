/**
 * Gmail のメッセージを出力用のレコードに変換する。
 *
 * Chatwork / Slack と同じ `ExportedMessage` の形に揃えているので、
 * Markdown 生成・ファイル名・--mine の抽出ロジックをそのまま共有できる。
 *   room_id   → threadId
 *   room_name → 件名（Re: を外したもの）
 *   account_id → 送信者のメールアドレス
 */
import { cleanEmailBody } from '../parser/email-cleanup.js';
import { collectAttachments, extractBody, findHeader } from '../parser/mime.js';
import { formatIso } from '../util/date.js';
import {
  displayNameOf,
  normalizeSubject,
  parseAddress,
  parseAddressList,
  type GmailMessage,
  type GmailThread,
} from '../gmail/types.js';
import type { ExportedMessage } from './record.js';

export interface GmailExportedMessage extends ExportedMessage {
  /** スレッドID（room_id と同じ値。分かりやすさのため別名でも持つ） */
  thread_id: string;
  /** 件名（Re: を含む生のもの） */
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  /** 自分が送信したメールか */
  is_mine: boolean;
  /** 添付ファイル名 */
  files: string[];
  /** 本文が text/plain 由来か HTML 由来か */
  body_source: 'text/plain' | 'text/html' | 'none';
  labels: string[];
}

export interface GmailRecordContext {
  /** 自分のメールアドレス（小文字） */
  myAddress: string;
  tzOffsetMinutes: number;
  /** 引用返信を残すか（既定は除去） */
  keepQuotes?: boolean;
  /** 署名を残すか（既定は除去） */
  keepSignature?: boolean;
}

/** メッセージの送信時刻（UNIX秒）。internalDate が無ければ Date ヘッダを見る。 */
export function messageEpoch(message: GmailMessage): number {
  if (message.internalDate) {
    const ms = Number(message.internalDate);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  const dateHeader = findHeader(message.payload, 'Date');
  if (dateHeader) {
    const parsed = Date.parse(dateHeader);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 0;
}

/** Message-ID / In-Reply-To の山括弧を外す。 */
function normalizeMessageId(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /<([^>]+)>/.exec(trimmed);
  return match ? (match[1] as string) : trimmed || null;
}

export function toGmailExportedMessage(
  message: GmailMessage,
  thread: GmailThread,
  context: GmailRecordContext,
): GmailExportedMessage {
  const payload = message.payload;
  const subject = findHeader(payload, 'Subject') ?? '';
  const from = parseAddress(findHeader(payload, 'From') ?? '');
  const to = parseAddressList(findHeader(payload, 'To'));
  const cc = parseAddressList(findHeader(payload, 'Cc'));

  const extracted = extractBody(payload);
  const cleaned = cleanEmailBody(extracted.text, {
    stripQuotes: context.keepQuotes !== true,
    stripSignature: context.keepSignature !== true,
  });

  const epoch = messageEpoch(message);
  const isMine = from?.email === context.myAddress;

  // スレッド内で1つ前のメールを返信先とみなす（In-Reply-To があればそちらを優先）
  const inReplyTo = normalizeMessageId(findHeader(payload, 'In-Reply-To'));
  const replyTo = inReplyTo ? findThreadMessageIdByRfcId(thread, inReplyTo) : previousInThread(thread, message.id);

  return {
    message_id: message.id,
    room_id: thread.id,
    room_name: normalizeSubject(subject),
    account_id: from?.email ?? '',
    account_name: displayNameOf(from),
    body: extracted.text,
    body_plain: cleaned,
    send_time: formatIso(epoch, context.tzOffsetMinutes),
    update_time: null,
    reply_to: replyTo,
    // メールでは「宛先」がメンションに相当する
    mentions: [...to, ...cc].map((address) => address.email),
    thread_id: thread.id,
    subject,
    from: from?.email ?? '',
    to: to.map((address) => address.email),
    cc: cc.map((address) => address.email),
    is_mine: isMine,
    files: collectAttachments(payload),
    body_source: extracted.source,
    labels: message.labelIds ?? [],
  };
}

/** RFC の Message-ID から、そのスレッド内の Gmail message id を引く。 */
function findThreadMessageIdByRfcId(thread: GmailThread, rfcId: string): string | null {
  for (const message of thread.messages ?? []) {
    const id = normalizeMessageId(findHeader(message.payload, 'Message-ID'));
    if (id === rfcId) return message.id;
  }
  return null;
}

/** スレッド内で1つ前のメールの id。先頭なら null。 */
function previousInThread(thread: GmailThread, messageId: string): string | null {
  const messages = thread.messages ?? [];
  const index = messages.findIndex((message) => message.id === messageId);
  if (index <= 0) return null;
  return (messages[index - 1] as GmailMessage).id;
}

/** スレッド群を時系列のレコード配列にする。 */
export function toTimeline(
  threads: readonly GmailThread[],
  context: GmailRecordContext,
): GmailExportedMessage[] {
  const records: GmailExportedMessage[] = [];
  for (const thread of threads) {
    for (const message of thread.messages ?? []) {
      records.push(toGmailExportedMessage(message, thread, context));
    }
  }
  // スレッドごとのまとまりを保ちつつ、スレッドの開始が古い順に並べる
  const threadOrder = new Map<string, number>();
  for (const record of records) {
    const current = threadOrder.get(record.thread_id);
    const epoch = Date.parse(record.send_time);
    if (current === undefined || epoch < current) threadOrder.set(record.thread_id, epoch);
  }
  return records.sort((a, b) => {
    const threadDiff =
      (threadOrder.get(a.thread_id) ?? 0) - (threadOrder.get(b.thread_id) ?? 0);
    if (threadDiff !== 0) return threadDiff;
    if (a.thread_id !== b.thread_id) return a.thread_id < b.thread_id ? -1 : 1;
    return Date.parse(a.send_time) - Date.parse(b.send_time);
  });
}
