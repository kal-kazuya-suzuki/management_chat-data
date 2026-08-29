/** API のレスポンスを出力用のレコードに変換する。 */
import { extractMentions, extractReplyTo, stripChatworkTags } from '../parser/chatwork-tags.js';
import { formatIso } from '../util/date.js';
import type { ChatworkMessage } from '../chatwork/types.js';
import type { MemberDirectory } from '../chatwork/members.js';

export interface ExportedMessage {
  message_id: string;
  room_id: string;
  room_name: string;
  account_id: string;
  account_name: string;
  /** Chatwork 記法を含む生の本文 */
  body: string;
  /** Chatwork 記法を除去した本文 */
  body_plain: string;
  /** ISO8601（--tz のオフセット付き） */
  send_time: string;
  /** 未編集の場合は null */
  update_time: string | null;
  /** [rp] があれば参照先の message_id */
  reply_to: string | null;
  /** [To:] の account_id 配列 */
  mentions: string[];
}

export interface RecordContext {
  roomId: string;
  roomName: string;
  directory: MemberDirectory;
  tzOffsetMinutes: number;
}

export function toExportedMessage(message: ChatworkMessage, context: RecordContext): ExportedMessage {
  const accountId = String(message.account?.account_id ?? '');
  const reply = extractReplyTo(message.body);

  return {
    message_id: message.message_id,
    room_id: context.roomId,
    room_name: context.roomName,
    account_id: accountId,
    account_name: context.directory.resolve(accountId, context.roomId, message.account?.name),
    body: message.body,
    body_plain: stripChatworkTags(message.body),
    send_time: formatIso(message.send_time, context.tzOffsetMinutes),
    update_time:
      message.update_time && message.update_time > 0
        ? formatIso(message.update_time, context.tzOffsetMinutes)
        : null,
    reply_to: reply ? reply.messageId : null,
    mentions: extractMentions(message.body),
  };
}

/** [rp] の参照先の発言者名を解決する（Markdown 表示用）。 */
export function resolveReplyTargetName(
  body: string,
  context: Pick<RecordContext, 'roomId' | 'directory'>,
  messagesById: Map<string, ExportedMessage>,
): string | null {
  const reply = extractReplyTo(body);
  if (!reply) return null;

  const target = messagesById.get(reply.messageId);
  if (target) return target.account_name;
  if (reply.accountId) return context.directory.resolve(reply.accountId, context.roomId);
  return null;
}
