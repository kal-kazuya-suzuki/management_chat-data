# management-chat-data

**Chatwork** と **Slack** の会話を、期間と部屋（ルーム / チャンネル）を指定してエクスポートする CLI です。

やり取りの分析、文体サンプルの作成、AI への入力データの用意を想定しています。
単体で動作し、他プロジェクト（slack-chat-hub など）には依存しません。
Chatwork 記法・Slack mrkdwn のパーサも本プロジェクト内に実装しています。

| | Chatwork | Slack |
| --- | --- | --- |
| エクスポート | `npm run export` | `npm run export:slack` |
| 部屋の一覧 | `npm run rooms` | `npm run channels` |
| 自分のID | `npm run me` | `npm run me:slack` |
| 期間の全件取得 | **不可**（[100件の壁](#-100件の壁重要)） | 可能 |

出力形式（JSON / Markdown）、`--mine` による文体サンプル抽出、期間の既定値は両者で共通です。

---

## セットアップ

必要環境: Node.js 20 以上

```bash
npm install
cp env.example env
# env を開いて CHATWORK_API_TOKEN を設定する
```

API トークンは Chatwork Web 版 → 右上のアイコン → **サービス連携** → **API Token** から取得できます。

---

## 使い方（Chatwork）

### 会話のエクスポート

```bash
npm run export -- --room=123456789 --from=2026-08-01 --to=2026-08-29
```

`npm run` に引数を渡すときは `--` が必要です（`npm run export -- --room=...`）。

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `--room=<ids>` | **必須** | 対象ルームID。カンマ区切りで複数指定可（`--room=111,222`）。繰り返し指定も可 |
| `--all` | off | 参加中の全ルームを対象にする。`--room` とは併用不可 |
| `--from=YYYY-MM-DD` | `--to` の29日前 | 期間の開始日（その日を含む） |
| `--to=YYYY-MM-DD` | 今日 | 期間の終了日（その日を含む） |
| `--format=json\|md\|both` | `both` | 出力形式 |
| `--mine` | off | 自分の発言のみを出力（[文体サンプル](#自分の発言だけを抜き出す---mine)を参照） |
| `--min-length=N` | `20` | `--mine` のとき、N 文字未満の自分の発言を除外 |
| `--out=<dir>` | `./exports` | 出力先ディレクトリ |
| `--tz=+09:00` | `+09:00` | 日付の解釈に使うタイムゾーン |
| `--max-pages=N` | `200` | 1ルームあたりの最大取得ページ数（1ページ100件） |
| `--verbose`, `-v` | off | 詳細ログ |
| `--help`, `-h` | – | ヘルプ |

#### 期間指定の既定値

- `--to` 省略時 … **今日**（`--tz` のタイムゾーンでの今日）
- `--from` 省略時 … **`--to` の29日前**。つまり `--from` も `--to` も省略すると **今日を含む直近30日** になります
- 期間は **両端を含みます**。`--from=2026-08-01 --to=2026-08-29` は
  `2026-08-01 00:00:00 +09:00` 〜 `2026-08-29 23:59:59 +09:00` を意味します

#### `--room` を必須にしている理由

全ルーム一括の取得は、API リクエストを大量に消費し、意図しない取引先のログまで手元に落としてしまうため、
既定では実行しません。本当に全ルームが必要なときだけ `--all` を明示してください。

### ルームIDを調べる

```bash
npm run rooms
npm run rooms -- --search=サンプル      # ルーム名で絞り込む
npm run rooms -- --type=group           # group / direct / my で絞り込む
npm run rooms -- --json                 # JSON で出力
```

```
room_id    種別          件数  ルーム名
---------  ------------  ----  --------------------
123456789  グループ      250   サンプル株式会社 / 定例
999        マイチャット  3     マイチャット
```

### 自分の account_id を調べる

```bash
npm run me
```

表示された `account_id` を `env` の `CHATWORK_MY_ACCOUNT_ID` に入れておくと、
`--mine` 実行時の `GET /me` を1回省けます。

### テスト・型チェック

```bash
npm test
npm run typecheck
```

---

## 使い方（Slack）

### 会話のエクスポート

```bash
npm run export:slack -- --channel=C0123ABCD --from=2026-07-01
npm run export:slack -- --channel=#web-project --from=2026-07-01   # 名前でも指定できる
```

| オプション | 既定値 | 説明 |
| --- | --- | --- |
| `--channel=<refs>` | **必須** | 対象チャンネル。ID（`C0123ABCD`）でも名前（`#general`）でも可。カンマ区切りで複数指定可 |
| `--all` | off | 全チャンネルを対象にする。`--channel` とは併用不可 |
| `--from` / `--to` | Chatwork 版と同じ | 期間（両端を含む） |
| `--format=json\|md\|both` | `both` | 出力形式 |
| `--mine` | off | 自分の発言のみを出力 |
| `--min-length=N` | `20` | `--mine` のとき、N 文字未満の自分の発言を除外 |
| `--out=<dir>` | `./exports` | 出力先ディレクトリ |
| `--tz=+09:00` | `+09:00` | 日付の解釈に使うタイムゾーン |
| `--no-threads` | off | スレッドの返信を取得しない（リクエスト数を大きく減らせる） |
| `--include-system` | off | 「〜が参加しました」などのシステムメッセージも含める |
| `--no-bots` | off | Bot の発言を除外する |
| `--page-limit=N` | `200` | 1リクエストの取得件数（最大1000） |
| `--max-pages=N` | `500` | チャンネルあたりの最大ページ数 |
| `--max-threads=N` | `1000` | 返信を取得するスレッド数の上限 |

チャンネル**名**で指定する場合、Slack の名前は小文字のみなので小文字に揃えて照合します。
**チャンネルIDは大文字で**指定してください（`general` のような名前と区別するため）。

### チャンネルIDを調べる

```bash
npm run channels
npm run channels -- --search=web          # 名前で絞り込む
npm run channels -- --member-only         # 自分が参加しているものだけ
npm run channels -- --json                # JSON で出力
```

```
channel_id   種別        参加  人数  チャンネル名
-----------  ----------  ----  ----  --------------------
C0123ABCD    パブリック  参加  8     web-project
C9999ZZZZ    パブリック        20    random
```

### 自分の Slack ユーザーID を調べる

```bash
npm run me:slack
```

表示された `user_id` を `env` の `SLACK_MY_USER_ID` に入れておくと、`--mine` の API 呼び出しを1回省けます。

---

## 出力

出力先は既定で `./exports/`。ファイル名にはルームIDと期間が入ります。

```
exports/chatwork_123456789_サンプル株式会社_定例_2026-08-01_2026-08-29.json
exports/chatwork_123456789_サンプル株式会社_定例_2026-08-01_2026-08-29.md
exports/chatwork_123456789_サンプル株式会社_定例_2026-08-01_2026-08-29_mine.md   # --mine のとき
exports/slack_C0123ABCD_web-project_2026-07-01_2026-08-30.json                   # Slack
exports/slack_C0123ABCD_web-project_2026-07-01_2026-08-30.md
```

先頭が `chatwork_` / `slack_` になり、続けて ルーム・チャンネルのID、名前、期間が入ります。

Markdown はルームごとに1ファイルです。

### JSON

1メッセージ1オブジェクトの配列です。

```json
[
  {
    "message_id": "1000000002",
    "room_id": "123456789",
    "room_name": "サンプル株式会社 / 定例",
    "account_id": "1111",
    "account_name": "山田太郎",
    "body": "[rp aid=2222 to=123456789-1000000001] 田中花子さん\n承知しました。",
    "body_plain": "承知しました。",
    "send_time": "2026-08-01T09:10:00+09:00",
    "update_time": null,
    "reply_to": "1000000001",
    "mentions": []
  }
]
```

| フィールド | 説明 |
| --- | --- |
| `message_id` | メッセージID |
| `room_id` / `room_name` | ルームIDと名前 |
| `account_id` / `account_name` | 発言者。名前は `GET /rooms/{room_id}/members` で解決（ルームごとに1回だけ取得してキャッシュ） |
| `body` | 生の本文（Chatwork 記法を含む） |
| `body_plain` | Chatwork 記法を除去した本文 |
| `send_time` | 送信日時（ISO8601、`--tz` のオフセット付き） |
| `update_time` | 編集日時。未編集なら `null` |
| `reply_to` | 返信先の識別子。Chatwork は `[rp]` の参照先 `message_id`、Slack はスレッドの親の `ts`。無ければ `null` |
| `mentions` | メンション先の配列。Chatwork は `[To:]` の `account_id`、Slack は `<@U…>` の user_id |

Slack のレコードには、さらに以下が付きます。

| フィールド | 説明 |
| --- | --- |
| `thread_ts` | 所属するスレッドの親の `ts`。スレッド外の発言は `null` |
| `is_thread_parent` | スレッドの親そのものなら `true` |
| `subtype` | `bot_message` など。通常の発言は `null` |
| `bot_id` | Bot の発言なら bot_id |
| `files` | 添付ファイル名の配列 |

Slack の `message_id` / `room_id` はそれぞれ `ts` / `channel_id` が入ります
（Markdown の見出しには `channel_id:` と表示されます）。

### Markdown

```markdown
# サンプル株式会社 / 定例

- room_id: 123456789
- 期間: 2026-08-01 〜 2026-08-29 (+09:00)
- 件数: 250
- 生成日時: 2026-08-29T22:39:47+09:00

> **取り扱い注意**: このファイルには取引先とのやり取りが含まれます。…

---

**2026-08-01 09:00 田中花子:**
お世話になっております。

**2026-08-01 09:10 山田太郎:**
> 田中花子さんの発言への返信

承知しました。
```

時系列に「日時 発言者: 本文」で並べ、Chatwork 記法は除去します。
`[rp]` は `> ○○さんの発言への返信` として表します（返信先が期間外などで特定できない場合は
`> 過去の発言への返信`）。

---

## 自分の発言だけを抜き出す（`--mine`）

文体サンプル用のモードです。

```bash
npm run export -- --room=123456789 --mine --min-length=30 --format=md
```

- 自分の `account_id` は `env` の `CHATWORK_MY_ACCOUNT_ID`、無ければ `GET /me` から自動取得します
- **Markdown には直前の相手の発言も併記します**。「どういう問いかけに、どう返しているか」が分かる形になります
- 自分の発言が連続する場合は、同じ相手の発言の下にまとめます
- `--min-length`（既定 20）未満の発言（「了解です」「ありがとうございます」など）は除外します。
  文字数は **Chatwork 記法を除去した後の本文** で数えます。`--min-length=0` で除外しません
- JSON も同じ条件で絞り込んだ自分の発言のみになります

```markdown
## 1

**相手 / 2026-08-01 09:05 田中花子:**

> 見積もりの件、いかがでしょうか。

**自分 / 2026-08-01 09:10:**

本日中にお送りします。内容に不足があればお知らせください。
```

---

## Chatwork 記法の除去

`body_plain` および Markdown 出力で、以下を処理します。

**中身ごと除去するもの**（発言者自身の文章ではない、あるいは表示用のマーカーのため）

| 記法 | 例 |
| --- | --- |
| `[To:12345]` / `[To:12345] 名前さん` | 宛先。直後の「〜さん」まで含めて除去 |
| `[rp aid=... to=room-msgid]` / 同 `名前さん` | 返信。`reply_to` と `mentions` には抽出済み |
| `[qt][qtmeta ...]...[/qt]` | 引用。**引用文は相手の文章なので中身ごと除去**（入れ子にも対応） |
| `[toall]` / `[hr]` / `[picon:...]` / `[dtext:...]` / `[preview ...]` / `[deleted]` | マーカー・システムテキスト |

**タグだけ除去して中身を残すもの**（中身が発言者の文章・情報のため）

| 記法 | 結果 |
| --- | --- |
| `[info]...[/info]` / `[title]...[/title]` | 見出しと本文をそのまま残す |
| `[code]...[/code]` | コード本文を残す |
| `[download:123]見積書.pdf[/download]` | `見積書.pdf` |

そのうえで、行末の空白を落とし、3行以上の連続改行は2行にまとめます。
`[重要]` のような **通常の角括弧の文章は壊しません**（Chatwork の既知タグのみを対象にしています）。

---

## Slack mrkdwn の除去

`body_plain` および Markdown 出力で、以下を処理します。

**IDを読める名前に置き換えるもの**

| 記法 | 結果 |
| --- | --- |
| `<@U12345>` | `@鈴木一也`（`users.list` で解決。不明なら表示名かID） |
| `<#C12345\|general>` | `#general` |
| `<!subteam^S123\|@dev>` | `@dev` |
| `<!here>` / `<!channel>` | `@here` / `@channel` |

**中身を残して記号を外すもの**

| 記法 | 結果 |
| --- | --- |
| `<https://example.com/a\|こちら>` | `こちら`（表示テキストが無ければ URL） |
| `<mailto:a@example.com\|a@example.com>` | `a@example.com` |
| `*太字*` / `_斜体_` / `~取り消し~` | 中身だけ残す |
| `` `code` `` / ` ```block``` ` | 中身だけ残す |
| `&amp;` / `&lt;` / `&gt;` | `&` / `<` / `>` |

- 絵文字ショートコード（`:bow:`）は**その人の書き方の一部**なので残します
- `snake_case_name` や `2 * 3` のような、装飾ではない記号は壊しません
- 添付ファイルがある場合、ファイル名を本文に追記します（本文が空でも内容が分かるように）
- 「〜が参加しました」などのシステムメッセージは既定で除外します（`--include-system` で含める）

## Chatwork の取得の仕組みと制約

### ⚠️ 100件の壁（重要）

**Chatwork API の `GET /rooms/{room_id}/messages` は、1回のリクエストで最大100件しか返さず、
公式には `offset` / `before` / `limit` といったページングパラメータが存在しません。**

本 CLI は、実運用で知られている **未公開の `message_id` パラメータ**
（`?force=1&message_id=<最古のメッセージID>` で続きのページを辿る）を使って過去へ遡ろうとします。

> **2026-08-29 時点の実測結果**: 本番 API に対して `message_id` / `before` / `offset` / `limit` を
> 試したところ、**いずれも無視され、常に同じ最新100件が返りました**。
> 総メッセージ数 3,430 件のルームでも取得できたのは直近100件のみです。
> つまり現状、**公開 API では直近100件より古いメッセージは取得できません**。
> 過去分が必要な場合は下記「100件より古いメッセージが必要な場合」を参照してください。

そのため本 CLI は **毎ページ「実際に古い方向へ進めているか」を検証**します。
遡れていないと判定した時点で取得を打ち切り、コンソールと Markdown ファイルの両方に警告を出します。

```
[警告] room 123456789: API が過去方向のページングに応答しませんでした（未公開パラメータ
       message_id が使えない可能性）。取得できたのは直近のメッセージのみです。
```

ルームの総メッセージ数が分かる場合は、取得できた件数と突き合わせて規模も表示します。

```
[警告] room 337086524: ルームの総メッセージ数 3430 件に対し 100 件しか取得できていません。
       指定期間の全体はカバーできていません（README「取得の仕組みと制約」を参照）。
```

**これらの警告が出た場合、指定期間の全体は取得できていません。**
黙って一部だけを出力することは無いので、警告の有無を必ず確認してください。

#### 100件より古いメッセージが必要な場合

公開 API では取得できないため、以下のいずれかを検討してください。

1. **Chatwork の管理者によるエクスポート** — ビジネスプランの管理者権限があれば、
   管理画面からチャットデータを一括エクスポートできます。全期間を確実に取得できる唯一の正規手段です
2. **ブラウザからの取得** — Web 版はスクロールで全履歴を読み込めます。
   ログイン済みセッションを使って抽出する必要があり、内部 API に依存するため壊れやすい方法です

### 取得の流れ

1. `GET /rooms/{room_id}/messages?force=1` で最新100件を取得
2. 最古のメッセージIDをカーソルに、`&message_id=<id>` で1ページずつ過去へ遡る
3. 以下のいずれかで停止する
   - 最古のメッセージが `--from` より前に到達した（＝期間をカバーできた）
   - 100件未満しか返らなかった、または 204 No Content（＝ルームの先頭に到達）
   - 過去方向に進んでいない、同じページが返り続けた（＝警告を出して打ち切り）
   - `--max-pages` に到達（＝警告を出して打ち切り）
4. 取得したメッセージを重複排除し、指定期間で絞り込み、送信日時の昇順に並べる

進捗はページごとにコンソールへ出力されます。

```
[1/1] room 123456789 サンプル株式会社 / 定例
  メンバー 取得済み
  ページ 1: +100 件 / 累計 100 件（最古 2026-08-01T21:30）
  ページ 2: +100 件 / 累計 200 件（最古 2026-08-01T13:10）
  ページ 3: +50 件 / 累計 250 件（最古 2026-08-01T09:00）
  期間内 250 件
```

### レート制限

Chatwork API の公称レート制限は **5分あたり300リクエスト** です。本 CLI は:

- スライディングウィンドウでリクエスト数を管理し、上限に達したらウィンドウが空くまで待機します
- `429 Too Many Requests` は **`Retry-After` ヘッダ** を優先して待機し、再試行します。
  `Retry-After` が無ければ `x-ratelimit-reset` を見て、それも無ければ指数バックオフ（1s → 2s → 4s …）にフォールバックします
- レスポンスの `x-ratelimit-remaining` が 0 になったら、`x-ratelimit-reset` まで自動で待ちます
- 5xx とネットワークエラーは指数バックオフ（ジッタ付き）で再試行します
- `400` / `401` / `403` / `404` は再試行せず即座にエラーにします
- リクエスト間隔の下限を `CHATWORK_MIN_INTERVAL_MS`（既定 250ms）で設けています。
  メッセージ取得は公称値より厳しく絞られることが報告されているため、余裕を持たせた既定値です

複数ルームを指定した場合、1ルームが失敗しても残りのルームの処理は続行し、
最後にまとめて警告を表示します（終了コードは 1 になります）。

### その他

- 未読が既読になる挙動については考慮していません（`force=1` で取得します）
- ルームのメンバー（`GET /rooms/{room_id}/members`）は **ルームごとに1回だけ**取得してキャッシュします。
  別ルームで取得した名前も再利用するため、メンション先の名前解決にも使われます

---

## Slack の取得の仕組みと制約

Chatwork と違い、Slack は `oldest` / `latest` で**期間を直接指定でき**、
`next_cursor` による正式なページングがあるため、**指定期間の取りこぼしは起きません**。

### 取得の流れ

1. `conversations.history` に `oldest` / `latest` / `limit=200` を渡し、`next_cursor` を辿って全ページ取得
2. 取得したメッセージのうち、返信を持つスレッドの親（`reply_count > 0`）について
   `conversations.replies` を呼び、返信を取得する
3. 重複排除し、期間で絞り込み、送信時刻の昇順に並べる

### ⚠️ レート制限（重要）

Slack は 2026-03-03 以降、**Marketplace 未掲載の配布アプリ**に対して
`conversations.history` / `conversations.replies` を **1リクエスト/分・1回15件** に制限しています。

| アプリの種類 | レート制限 | 1回の取得件数 |
| --- | --- | --- |
| **ワークスペース内製アプリ**（自分たちで作った内部アプリ） | 50+ / 分 | 1000件 |
| Marketplace 掲載アプリ | 従来どおり | 1000件 |
| Marketplace 未掲載の配布アプリ | **1 / 分** | **15件** |

**内部アプリを使ってください。** https://api.slack.com/apps で自分のワークスペース用に
アプリを作り、配布設定をしなければ内部アプリ扱いになります。

本 CLI は、200件を要求したのに15件しか返らない状態が続いた場合に、
この制限に当たっている可能性を警告します。

```
[警告] web-project: 1回のリクエストで 15 件しか返っていません（200 件を要求）。
       Marketplace 未掲載の配布アプリに課される制限（1分1リクエスト・1回15件）に
       当たっている可能性があります。
```

429 を受けた場合は `Retry-After` ヘッダに従って待機し、再試行します。
実行の最後に、429 に当たった回数も表示します。

### スレッドの扱い

`conversations.history` は**スレッドの親（トップレベル）しか返しません**。
返信を含めるには、スレッドごとに `conversations.replies` を呼ぶ必要があります。

- 返信は `reply_to` に親の `ts` が入り、Markdown では `> ○○さんの発言への返信` と表示されます
- スレッドが多いチャンネルではリクエスト数が増えます。速度を優先するなら `--no-threads`
- **期間の開始より前に始まったスレッドへの、期間内の返信は取得できません**。
  history が期間外の親を返さず、そのスレッドの存在自体が分からないためです。
  古いスレッドの返信も必要な場合は `--from` を早めてください（実行時に補足として表示します）

### 必要なスコープ

| スコープ | 用途 |
| --- | --- |
| `channels:history` / `channels:read` | パブリックチャンネル |
| `groups:history` / `groups:read` | プライベートチャンネル |
| `im:history` / `im:read` | DM |
| `mpim:history` / `mpim:read` | グループDM |
| `users:read` | ユーザー名の解決 |

Bot トークン（`xoxb-`）の場合、Bot が参加しているチャンネルしか履歴を取得できません
（`not_in_channel` エラー）。チャンネルで `/invite` するか、ユーザートークン（`xoxp-`）を使ってください。

## 環境変数

プロジェクト直下の **`env`**（ドット無し）に記述します（`env.example` をコピーして使ってください）。
隠しファイルにならないようドットを付けていません。従来どおり `.env` を置いている場合はそちらも読み込みます（`env` があればそちらを優先）。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `CHATWORK_API_TOKEN` | **必須** | Chatwork API トークン |
| `CHATWORK_MY_ACCOUNT_ID` | – | 自分の account_id。未設定なら `--mine` 実行時に `GET /me` で自動取得 |
| `CHATWORK_API_BASE` | `https://api.chatwork.com/v2` | API のベース URL |
| `CHATWORK_TZ_OFFSET` | `+09:00` | 日付の解釈に使うタイムゾーン（`--tz` で上書き可） |
| `CHATWORK_RATE_LIMIT` | `300` | ウィンドウあたりの最大リクエスト数 |
| `CHATWORK_RATE_WINDOW_SEC` | `300` | レート制限のウィンドウ長（秒） |
| `CHATWORK_MIN_INTERVAL_MS` | `250` | リクエスト間の最小間隔（ミリ秒） |
| `CHATWORK_MAX_RETRIES` | `5` | リトライ回数（429 / 5xx / ネットワークエラー） |

### Slack

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `SLACK_TOKEN` | **必須** | Slack のトークン。`SLACK_USER_TOKEN` / `SLACK_BOT_TOKEN` も同じ用途で読みます（この順で最初に見つかったものを使用。slack-chat-hub と同じキー名） |
| `SLACK_MY_USER_ID` | – | 自分の user_id。未設定なら `--mine` 実行時に `auth.test` で自動取得 |
| `SLACK_API_BASE` | `https://slack.com/api` | API のベース URL |
| `SLACK_RATE_LIMIT` | `50` | ウィンドウあたりの最大リクエスト数 |
| `SLACK_RATE_WINDOW_SEC` | `60` | レート制限のウィンドウ長（秒） |
| `SLACK_MIN_INTERVAL_MS` | `200` | リクエスト間の最小間隔（ミリ秒） |
| `SLACK_MAX_RETRIES` | `5` | リトライ回数 |

タイムゾーン（`CHATWORK_TZ_OFFSET`）は Chatwork / Slack で共通です。

---

## 🔒 取り扱い注意

**`exports/` 以下の出力ファイルには、取引先とのやり取りがそのまま含まれます。**

- `exports/` と `env` は `.gitignore` 済みです。**絶対にコミットしないでください**
- 出力した Markdown / JSON を外部サービス（AI ツール、翻訳サービス、クラウドストレージ等）へ
  アップロードする際は、取引先との守秘義務・契約条件を必ず確認してください
- ファイルには相手の氏名・`account_id`・組織名が含まれます。
  第三者への共有時はマスキングや当該箇所の削除を検討してください
- 不要になった出力ファイルは削除してください
- API トークンはアカウントの全ルームへのアクセス権を持ちます。共有・貼り付けに注意してください

生成される Markdown の先頭にも、取り扱い注意の注記を自動で入れています。

---

## ディレクトリ構成

```
.
├── src/
│   ├── args.ts                   CLI 引数のパース（Chatwork / Slack 両方）
│   ├── config.ts                 env / 環境変数の読み込み
│   ├── cli/
│   │   ├── export.ts             npm run export        (Chatwork)
│   │   ├── rooms.ts              npm run rooms         (Chatwork)
│   │   ├── me.ts                 npm run me            (Chatwork)
│   │   ├── export-slack.ts       npm run export:slack  (Slack)
│   │   ├── channels.ts           npm run channels      (Slack)
│   │   └── me-slack.ts           npm run me:slack      (Slack)
│   ├── chatwork/
│   │   ├── client.ts             API クライアント（レート制限・リトライ）
│   │   ├── pager.ts              期間指定のページング
│   │   ├── members.ts            account_id → 名前の解決とキャッシュ
│   │   └── types.ts              API のレスポンス型
│   ├── slack/
│   │   ├── client.ts             Web API クライアント（ok:false 判定・429対応）
│   │   ├── pager.ts              期間指定のカーソルページング＋スレッド返信
│   │   ├── users.ts              user_id → 名前の解決とキャッシュ
│   │   └── types.ts              API のレスポンス型
│   ├── parser/
│   │   ├── chatwork-tags.ts      Chatwork 記法のパーサ
│   │   └── slack-markup.ts       Slack mrkdwn のパーサ
│   ├── output/                   ← Chatwork / Slack で共通
│   │   ├── record.ts             出力レコードへの変換（Chatwork）
│   │   ├── slack-record.ts       出力レコードへの変換（Slack）
│   │   ├── markdown.ts           Markdown 生成
│   │   └── files.ts              ファイル名と書き出し
│   └── util/                     ← Chatwork / Slack で共通
│       ├── date.ts               日付・タイムゾーン
│       ├── rate-limiter.ts       レートリミッタ
│       ├── table.ts              コンソール表の整形
│       └── log.ts                ログ出力
├── env.example                   環境変数のサンプル（env にコピーして使う）
├── test/                         vitest（記法パーサとページング処理を中心に）
└── exports/                      出力先（.gitignore 済み）
```

Slack のレコードは Chatwork と同じ `ExportedMessage` の形に揃えているため、
Markdown 生成・ファイル名・`--mine` の抽出ロジックをそのまま共有しています
（Slack 固有の `thread_ts` / `subtype` / `files` は追加フィールドとして持ちます）。

ログはすべて stderr に出力し、stdout は成果物（`npm run rooms` の一覧など）専用にしています。
`npm run rooms -- --json > rooms.json` のようにパイプできます。
