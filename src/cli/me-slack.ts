/**
 * npm run me:slack — 自分の Slack ユーザーID を表示する。
 * env の SLACK_MY_USER_ID に設定しておくと --mine で API 呼び出しを1回減らせる。
 */
import { loadSlackConfig } from '../config.js';
import { SlackClient } from '../slack/client.js';
import * as log from '../util/log.js';

async function main(): Promise<void> {
  const config = loadSlackConfig();
  const client = new SlackClient({
    token: config.token,
    baseUrl: config.baseUrl,
    rateLimit: config.rateLimit,
    rateWindowSeconds: config.rateWindowSeconds,
    minIntervalMs: config.minIntervalMs,
    maxRetries: config.maxRetries,
  });

  const auth = await client.authTest();

  log.out(`user_id     : ${auth.user_id}`);
  log.out(`ユーザー名  : ${auth.user}`);
  log.out(`ワークスペース: ${auth.team} (${auth.team_id})`);
  log.out(`トークン    : ${config.tokenSource}`);
  log.out('');
  log.out('env に以下を追記しておくと --mine が1リクエスト分速くなります:');
  log.out(`  SLACK_MY_USER_ID=${auth.user_id}`);

  if (config.tokenSource === 'SLACK_BOT_TOKEN') {
    log.out('');
    log.out('※ Bot トークンです。user_id は Bot 自身のIDなので、--mine で「自分の発言」を');
    log.out('  取り出したい場合は、あなた個人の user_id を SLACK_MY_USER_ID に設定してください。');
    log.out('  （`npm run channels` で見えるチャンネルも Bot が参加しているものに限られます）');
  }
}

main().catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
