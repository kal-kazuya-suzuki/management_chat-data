/** .env / 環境変数の読み込み。 */
import 'dotenv/config';

export interface AppConfig {
  token: string;
  baseUrl: string;
  myAccountId: string | null;
  tzOffset: string;
  rateLimit: number;
  rateWindowSeconds: number;
  minIntervalMs: number;
  maxRetries: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`環境変数 ${name} は 0 以上の数値で指定してください（現在: "${raw}"）`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  const token = (process.env.CHATWORK_API_TOKEN ?? '').trim();
  if (!token) {
    throw new Error(
      'CHATWORK_API_TOKEN が設定されていません。\n' +
        '  .env.example を .env にコピーしてトークンを設定してください:\n' +
        '    cp .env.example .env\n' +
        '  トークンは Chatwork Web版 → 右上アイコン → サービス連携 → API Token から取得できます。',
    );
  }

  const myAccountId = (process.env.CHATWORK_MY_ACCOUNT_ID ?? '').trim();

  return {
    token,
    baseUrl: (process.env.CHATWORK_API_BASE ?? 'https://api.chatwork.com/v2').trim(),
    myAccountId: myAccountId === '' ? null : myAccountId,
    tzOffset: (process.env.CHATWORK_TZ_OFFSET ?? '+09:00').trim(),
    rateLimit: readInt('CHATWORK_RATE_LIMIT', 300),
    rateWindowSeconds: readInt('CHATWORK_RATE_WINDOW_SEC', 300),
    minIntervalMs: readInt('CHATWORK_MIN_INTERVAL_MS', 250),
    maxRetries: readInt('CHATWORK_MAX_RETRIES', 5),
  };
}
