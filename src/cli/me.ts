/**
 * npm run me — 自分の account_id を表示する。
 * env の CHATWORK_MY_ACCOUNT_ID に設定しておくと --mine で API 呼び出しを1回減らせる。
 */
import { loadConfig } from '../config.js';
import { ChatworkClient } from '../chatwork/client.js';
import * as log from '../util/log.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ChatworkClient({
    token: config.token,
    baseUrl: config.baseUrl,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  const me = await client.getMe();

  log.out(`account_id      : ${me.account_id}`);
  log.out(`名前            : ${me.name}`);
  log.out(`chatwork_id     : ${me.chatwork_id}`);
  if (me.organization_name) log.out(`組織            : ${me.organization_name}`);
  if (me.department) log.out(`部署            : ${me.department}`);
  log.out('');
  log.out('env に以下を追記しておくと --mine が1リクエスト分速くなります:');
  log.out(`  CHATWORK_MY_ACCOUNT_ID=${me.account_id}`);
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
