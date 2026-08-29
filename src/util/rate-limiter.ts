/**
 * スライディングウィンドウ方式のレートリミッタ。
 *
 * Chatwork API の公称レート制限は「5分あたり300リクエスト」。
 * それに加えて、リクエスト間の最小間隔も設けられるようにしている
 * （メッセージ取得は公称値より厳しく絞られることが実運用で報告されているため）。
 *
 * 時計と sleep を注入できるようにしてテスト可能にしてある。
 */
export interface RateLimiterOptions {
  /** ウィンドウあたりの最大リクエスト数 */
  limit: number;
  /** ウィンドウ長（秒） */
  windowSeconds: number;
  /** リクエスト間の最小間隔（ミリ秒） */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (waitMs: number, reason: string) => void;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWait: ((waitMs: number, reason: string) => void) | undefined;

  /** 直近ウィンドウ内のリクエスト時刻 */
  private readonly timestamps: number[] = [];
  private lastRequestAt = -Infinity;
  /** サーバから指示された「この時刻までは待つ」（429 の Retry-After など） */
  private pausedUntil = 0;

  constructor(options: RateLimiterOptions) {
    this.limit = Math.max(1, options.limit);
    this.windowMs = Math.max(1, options.windowSeconds) * 1000;
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? 0);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.onWait = options.onWait;
  }

  /** リクエスト直前に呼ぶ。必要なら待機してからトークンを消費する。 */
  async acquire(): Promise<void> {
    // 最大でもウィンドウ長を超えるループにはならないが、念のため上限を設ける。
    for (let guard = 0; guard < 1000; guard += 1) {
      const now = this.now();
      const waitMs = this.computeWait(now);
      if (waitMs <= 0) {
        this.record(now);
        return;
      }
      this.onWait?.(waitMs, this.describeWait(now));
      await this.sleep(waitMs);
    }
    throw new Error('レート制限の待機がループしました（設定値を確認してください）');
  }

  /** 429 などを受けたとき、次のリクエストまで強制的に待たせる。 */
  pauseFor(ms: number): void {
    if (ms <= 0) return;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** レスポンスヘッダの x-ratelimit-* を反映する。 */
  applyHeaders(remaining: number | null, resetEpochSeconds: number | null): void {
    if (remaining === null || remaining > 0) return;
    if (resetEpochSeconds === null) return;
    const waitMs = resetEpochSeconds * 1000 - this.now();
    this.pauseFor(waitMs);
  }

  /** ウィンドウ内の残り回数（概算・表示用）。 */
  remaining(): number {
    this.prune(this.now());
    return Math.max(0, this.limit - this.timestamps.length);
  }

  private computeWait(now: number): number {
    this.prune(now);
    let wait = 0;
    if (this.pausedUntil > now) wait = Math.max(wait, this.pausedUntil - now);
    if (this.minIntervalMs > 0) {
      const nextAllowed = this.lastRequestAt + this.minIntervalMs;
      if (nextAllowed > now) wait = Math.max(wait, nextAllowed - now);
    }
    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0] as number;
      wait = Math.max(wait, oldest + this.windowMs - now);
    }
    return wait;
  }

  private describeWait(now: number): string {
    if (this.pausedUntil > now) return 'サーバ指示による待機';
    if (this.timestamps.length >= this.limit) return 'レート制限（ウィンドウ上限）';
    return '最小リクエスト間隔';
  }

  private record(now: number): void {
    this.timestamps.push(now);
    this.lastRequestAt = now;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && (this.timestamps[0] as number) <= cutoff) {
      this.timestamps.shift();
    }
  }
}
