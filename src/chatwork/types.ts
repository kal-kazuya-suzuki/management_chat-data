/** Chatwork API v2 のレスポンス型（このプロジェクトで使う範囲のみ）。 */

export interface ChatworkAccount {
  account_id: number;
  name: string;
  avatar_image_url?: string;
}

export interface ChatworkMessage {
  message_id: string;
  account: ChatworkAccount;
  body: string;
  /** UNIX 秒 */
  send_time: number;
  /** UNIX 秒。未編集の場合は 0 */
  update_time: number;
}

export interface ChatworkRoom {
  room_id: number;
  name: string;
  type: 'my' | 'direct' | 'group' | string;
  role: string;
  sticky: boolean;
  unread_num: number;
  mention_num: number;
  mytask_num: number;
  message_num: number;
  file_num: number;
  task_num: number;
  icon_path: string;
  last_update_time: number;
}

export interface ChatworkMember {
  account_id: number;
  role: string;
  name: string;
  chatwork_id?: string;
  organization_id?: number;
  organization_name?: string;
  department?: string;
  avatar_image_url?: string;
}

export interface ChatworkMe {
  account_id: number;
  room_id: number;
  name: string;
  chatwork_id: string;
  organization_id: number;
  organization_name: string;
  department: string;
  mail?: string;
  login_mail?: string;
}
