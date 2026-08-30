/**
 * user_id → 表示名の解決。
 *
 * `users.list` を **1回だけ**呼んでワークスペース全員分をキャッシュする。
 * メッセージごとに `users.info` を呼ぶとレート制限にすぐ当たるため。
 */
import { pickUserName, type SlackUser } from './types.js';

export interface UserSource {
  listUsers(): Promise<SlackUser[]>;
}

export class UserDirectory {
  private readonly names = new Map<string, string>();
  private readonly bots = new Set<string>();
  private loaded = false;

  constructor(private readonly source: UserSource) {}

  /** ワークスペースのユーザーを取得してキャッシュする（2回目以降は API を呼ばない）。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    for (const user of await this.source.listUsers()) {
      this.names.set(user.id, pickUserName(user));
      if (user.is_bot) this.bots.add(user.id);
    }
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get size(): number {
    return this.names.size;
  }

  /** メッセージ側の username など、API 以外で分かった名前を取り込む。 */
  remember(userId: string | undefined, name: string | undefined): void {
    if (!userId || !name) return;
    if (!this.names.has(userId)) this.names.set(userId, name);
  }

  /** キャッシュ済みの名前を返す。未知なら fallback、それも無ければ user_id そのもの。 */
  resolve(userId: string | undefined, fallback?: string): string {
    if (!userId) return fallback ?? '(不明なユーザー)';
    return this.names.get(userId) ?? fallback ?? userId;
  }

  isBot(userId: string | undefined): boolean {
    return userId !== undefined && this.bots.has(userId);
  }

  /** Slack 記法パーサに渡すための user_id → 名前のマップ。 */
  toNameMap(): Map<string, string> {
    return this.names;
  }
}
