/**
 * Slack のメッセージを出力用のレコードに変換する。
 *
 * Chatwork 版（record.ts）と同じ `ExportedMessage` の形に揃えているので、
 * Markdown 生成・ファイル名・--mine の抽出をそのまま共有できる。
 * Slack 固有の情報（スレッド・subtype など）は追加フィールドとして持たせる。
 */
import { extractMentions, stripSlackMarkup } from '../parser/slack-markup.js';
import { tsToEpoch } from '../slack/pager.js';
import { formatIso } from '../util/date.js';
import type { SlackMessage } from '../slack/types.js';
import type { UserDirectory } from '../slack/users.js';
import type { ExportedMessage } from './record.js';

export interface SlackExportedMessage extends ExportedMessage {
  /** スレッドの親の ts。スレッドに属さない発言は null */
  thread_ts: string | null;
  /** スレッドの親そのものなら true */
  is_thread_parent: boolean;
  /** channel_join / bot_message など。通常の発言は null */
  subtype: string | null;
  /** Bot の発言なら bot_id */
  bot_id: string | null;
  /** 添付ファイル名 */
  files: string[];
}

export interface SlackRecordContext {
  channelId: string;
  channelName: string;
  directory: UserDirectory;
  tzOffsetMinutes: number;
  /** channel_id → チャンネル名（本文中の <#C123> を解決するため） */
  channelNames?: Map<string, string>;
}

/**
 * 通常の発言ではない subtype。
 * 「〜が参加しました」などは会話の分析にも文体サンプルにもノイズなので既定で除外する。
 */
const SYSTEM_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'pinned_item',
  'unpinned_item',
  'reminder_add',
  'bot_add',
  'bot_remove',
  'app_conversation_join',
]);

/** 参加・退出などのシステムメッセージか。 */
export function isSystemMessage(message: SlackMessage): boolean {
  return message.subtype !== undefined && SYSTEM_SUBTYPES.has(message.subtype);
}

/** 添付・attachments から本文を補う（テキストが空でも内容が分かるように）。 */
function extraText(message: SlackMessage): string[] {
  const parts: string[] = [];
  for (const file of message.files ?? []) {
    const name = file.title?.trim() || file.name?.trim();
    if (name) parts.push(name);
  }
  for (const attachment of message.attachments ?? []) {
    const text = attachment.title?.trim() || attachment.text?.trim() || attachment.fallback?.trim();
    if (text) parts.push(text);
  }
  return parts;
}

export function toSlackExportedMessage(
  message: SlackMessage,
  context: SlackRecordContext,
): SlackExportedMessage {
  const userId = message.user ?? '';
  const rawText = message.text ?? '';
  const epoch = tsToEpoch(message.ts);

  const plainParts = [
    stripSlackMarkup(rawText, {
      userNames: context.directory.toNameMap(),
      channelNames: context.channelNames,
    }),
    ...extraText(message),
  ].filter((part) => part !== '');

  const isParent = message.thread_ts !== undefined && message.thread_ts === message.ts;

  return {
    message_id: message.ts,
    room_id: context.channelId,
    room_name: context.channelName,
    account_id: userId,
    account_name: context.directory.resolve(userId, message.username ?? message.bot_id ?? undefined),
    body: rawText,
    body_plain: plainParts.join('\n'),
    send_time: formatIso(Math.floor(epoch), context.tzOffsetMinutes),
    update_time: message.edited?.ts
      ? formatIso(Math.floor(tsToEpoch(message.edited.ts)), context.tzOffsetMinutes)
      : null,
    // スレッドの返信は「親への返信」として扱う（Chatwork の [rp] に相当）
    reply_to: message.thread_ts && !isParent ? message.thread_ts : null,
    mentions: extractMentions(rawText),
    thread_ts: message.thread_ts ?? null,
    is_thread_parent: isParent,
    subtype: message.subtype ?? null,
    bot_id: message.bot_id ?? null,
    files: (message.files ?? [])
      .map((file) => file.title?.trim() || file.name?.trim() || '')
      .filter((name) => name !== ''),
  };
}
