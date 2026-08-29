/**
 * account_id → 表示名の解決。
 *
 * GET /rooms/{room_id}/members はルームごとに1回だけ呼び、結果をキャッシュする。
 * 別ルームで取得した名前もグローバルキャッシュに溜めるので、
 * メンション先が別ルームのメンバーでも名前が付くことがある。
 */
import type { ChatworkMember } from './types.js';

export interface MemberSource {
  getRoomMembers(roomId: string): Promise<ChatworkMember[]>;
}

export class MemberDirectory {
  private readonly perRoom = new Map<string, Map<string, string>>();
  private readonly global = new Map<string, string>();

  constructor(private readonly source: MemberSource) {}

  /** ルームのメンバーを取得してキャッシュする（2回目以降は API を呼ばない）。 */
  async load(roomId: string): Promise<Map<string, string>> {
    const cached = this.perRoom.get(roomId);
    if (cached) return cached;

    const names = new Map<string, string>();
    const members = await this.source.getRoomMembers(roomId);
    for (const member of members) {
      const id = String(member.account_id);
      names.set(id, member.name);
      this.global.set(id, member.name);
    }
    this.perRoom.set(roomId, names);
    return names;
  }

  /** メッセージに含まれる account.name などを名前解決の材料として取り込む。 */
  remember(accountId: string | number, name: string | undefined): void {
    if (!name) return;
    const id = String(accountId);
    if (!this.global.has(id)) this.global.set(id, name);
  }

  /** キャッシュ済みの名前を返す。未知なら fallback、それも無ければ "(account_id)" 形式。 */
  resolve(accountId: string | number, roomId?: string, fallback?: string): string {
    const id = String(accountId);
    if (roomId) {
      const roomNames = this.perRoom.get(roomId);
      const hit = roomNames?.get(id);
      if (hit) return hit;
    }
    return this.global.get(id) ?? fallback ?? `(account_id:${id})`;
  }

  /** ルームのメンバーがキャッシュ済みかどうか。 */
  isLoaded(roomId: string): boolean {
    return this.perRoom.has(roomId);
  }
}
