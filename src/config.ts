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

export interface SlackConfig {
  token: string;
  /** どの環境変数から読んだか（エラーメッセージ用） */
  tokenSource: string;
  baseUrl: string;
  myUserId: string | null;
  tzOffset: string;
  rateLimit: number;
  rateWindowSeconds: number;
  minIntervalMs: number;
  maxRetries: number;
}

/**
 * Slack のトークンは SLACK_TOKEN を第一候補にしつつ、
 * 既存の slack-chat-hub と同じキー名（SLACK_USER_TOKEN / SLACK_BOT_TOKEN）も受け付ける。
 * ユーザートークンの方が見える範囲が広いので、そちらを優先する。
 */
const SLACK_TOKEN_KEYS = ['SLACK_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN'] as const;

export function loadSlackConfig(): SlackConfig {
  let token = '';
  let tokenSource = '';
  for (const key of SLACK_TOKEN_KEYS) {
    const value = (process.env[key] ?? '').trim();
    if (value) {
      token = value;
      tokenSource = key;
      break;
    }
  }

  if (!token) {
    throw new Error(
      'Slack のトークンが設定されていません。\n' +
        `  ${SLACK_TOKEN_KEYS.join(' / ')} のいずれかを設定してください。\n` +
        (loadedEnvFile === null
          ? '  設定ファイルが見つかりません。env.example を env にコピーしてください:\n    cp env.example env\n'
          : `  設定ファイル: ${loadedEnvFile}\n`) +
        '  トークンは https://api.slack.com/apps でアプリを作り、\n' +
        '  OAuth & Permissions の画面から取得できます（必要なスコープは README を参照）。',
    );
  }

  const myUserId = (process.env.SLACK_MY_USER_ID ?? '').trim();

  return {
    token,
    tokenSource,
    baseUrl: (process.env.SLACK_API_BASE ?? 'https://slack.com/api').trim(),
    myUserId: myUserId === '' ? null : myUserId,
    tzOffset: (process.env.CHATWORK_TZ_OFFSET ?? process.env.SLACK_TZ_OFFSET ?? '+09:00').trim(),
    rateLimit: readInt('SLACK_RATE_LIMIT', 50),
    rateWindowSeconds: readInt('SLACK_RATE_WINDOW_SEC', 60),
    minIntervalMs: readInt('SLACK_MIN_INTERVAL_MS', 200),
    maxRetries: readInt('SLACK_MAX_RETRIES', 5),
  };
}
