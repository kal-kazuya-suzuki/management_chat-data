/**
 * npm run gmail:auth — 一度だけ実行する OAuth 同意フロー。
 * ブラウザで同意すると、env に貼るリフレッシュトークンが表示される。
 */
import { loadGmailClientCredentials } from '../config.js';
import { runAuthorizationFlow, GMAIL_READONLY_SCOPE } from '../gmail/auth.js';
import * as log from '../util/log.js';

async function main(): Promise<void> {
  const { clientId, clientSecret, authPort } = loadGmailClientCredentials();

  log.info('Gmail の認証を開始します。');
  log.info(`  スコープ       : ${GMAIL_READONLY_SCOPE}（読み取り専用）`);
  log.info(`  リダイレクト先 : http://127.0.0.1:${authPort}`);
  log.info('');
  log.info('Google Cloud の OAuth クライアントに、上のリダイレクト URI が');
  log.info('登録されていることを確認してください（種類: デスクトップアプリなら自動で使えます）。');
  log.info('');

  const { refreshToken, scope } = await runAuthorizationFlow({
    clientId,
    clientSecret,
    port: authPort,
  });

  log.info('');
  log.info(`認証に成功しました（付与されたスコープ: ${scope}）。`);
  log.info('');
  log.info('env に以下を追記してください:');
  log.out('');
  log.out(`GMAIL_REFRESH_TOKEN=${refreshToken}`);
  log.out('');
  log.info('※ OAuth 同意画面の User type が「テスト中（外部）」だと、');
  log.info('  このリフレッシュトークンは7日で失効します。「内部」に設定してください。');
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
