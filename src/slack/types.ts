/** Slack Web API のレスポンス型（このプロジェクトで使う範囲のみ）。 */

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  filetype?: string;
}

export interface SlackMessage {
  /** メッセージの識別子であり送信時刻でもある（"1756400000.123456"） */
  ts: string;
  type?: string;
  /** channel_join / channel_leave / bot_message など。通常の発言では未設定 */
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  /** スレッドの親の ts。親メッセージ自身にも入る */
  thread_ts?: string;
  /** スレッドの返信数（親メッセージにのみ入る） */
  reply_count?: number;
  /** 返信をチャンネルにも流した返信で true */
  subscribed?: boolean;
  edited?: { user?: string; ts: string };
  files?: SlackFile[];
  attachments?: Array<{ text?: string; fallback?: string; title?: string }>;
}

export interface SlackChannel {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  /** DM の場合の相手の user_id */
  user?: string;
  topic?: { value?: string };
  purpose?: { value?: string };
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    display_name_normalized?: string;
    real_name_normalized?: string;
  };
}

export interface SlackAuthTest {
  ok: boolean;
  user_id: string;
  user: string;
  team: string;
  team_id: string;
  url?: string;
}

export interface SlackResponseMetadata {
  next_cursor?: string;
}

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
  warning?: string;
  needed?: string;
  provided?: string;
  response_metadata?: SlackResponseMetadata;
}

export interface SlackHistoryResponse extends SlackApiResponse {
  messages?: SlackMessage[];
  has_more?: boolean;
}

export interface SlackConversationsListResponse extends SlackApiResponse {
  channels?: SlackChannel[];
}

export interface SlackUsersListResponse extends SlackApiResponse {
  members?: SlackUser[];
}

/** ユーザーの表示名として最も適切なものを選ぶ。 */
export function pickUserName(user: SlackUser): string {
  return (
    user.profile?.display_name?.trim() ||
    user.profile?.real_name?.trim() ||
    user.real_name?.trim() ||
    user.name?.trim() ||
    user.id
  );
}

/** チャンネルの種別を日本語ラベルにする。 */
export function channelKind(channel: SlackChannel): string {
  if (channel.is_im) return 'DM';
  if (channel.is_mpim) return 'グループDM';
  if (channel.is_private) return 'プライベート';
  return 'パブリック';
}
