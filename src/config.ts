/**
 * 環境変数の読み込み。
 *
 * 設定ファイルはプロジェクト直下の `env`（ドット無し）。
 * Finder やエディタで隠しファイルにならないよう、あえてドットを付けていない。
 * 従来どおり `.env` を置いている場合はそちらも読む（`env` があればそちらを優先）。
 * どちらも .gitignore 済み。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 実際に読み込んだ設定ファイル名（エラーメッセージ用）。見つからなければ null。 */
export const loadedEnvFile: string | null = (() => {
  for (const name of ['env', '.env']) {
    const filePath = path.join(PROJECT_ROOT, name);
    if (existsSync(filePath)) {
      loadDotenv({ path: filePath });
      return name;
    }
  }
  return null;
})();

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
        (loadedEnvFile === null
          ? '  設定ファイルが見つかりません。env.example を env にコピーしてください:\n    cp env.example env\n'
          : `  設定ファイル "${loadedEnvFile}" は読み込めましたが、CHATWORK_API_TOKEN が空です。\n`) +
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
