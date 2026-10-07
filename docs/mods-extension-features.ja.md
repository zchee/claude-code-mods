# Claude Code mods で拡張できる機能の全調査

[English](mods-extension-features.en.md) | 日本語

調査日: 2026-10-07 / 調査対象: 公式ドキュメント 10 ページ（v2.1.290 時点の記載）と、インストール済み Claude Code 2.1.292 が書き出した型定義 `claude-code/index.d.ts`（15,776 行）

## 結論

mod は「JavaScript/TypeScript のイベントハンドラ（hook）を Claude Code のプロセス内で動かすプラグイン」です。拡張点は次の 4 系統に分かれます。

1. **イベント**: ドキュメント記載の固有イベント 46 種、設定フック由来の `classic.*` 33 種、mods API 呼び出しそのもの（`fs.read` など）。各 hook は「観察」「書き換え」「代わりに回答」のどれかを行う。
2. **mods API**（`$`）: 21 の名前空間。コマンド・ツール・サブエージェント型の追加、モデル呼び出し、タイマー、セッション間メッセージ、ファイル・プロセス・HTTP・MCP、音声など。
3. **UI**: 描画できる場所（render site）15 箇所、描画要素 12 種。独自ペイン、プロンプト上の帯（band）、Claude Code 自身の行（スピナー、ツール行、質問ダイアログなど）の差し替えができる。権限プロンプトだけは変更できない。
4. **開発・運用基盤**: ホットリロード、型定義の自動生成、`claude plugin validate` による静的解析、`claude plugin test` によるテスト、組織向けのポリシー（読み込み順、組み込みガード、ポリシー mod）。

2.1.292 の型定義には、ドキュメントに載っていないイベント `prompt.autocomplete`（プロンプト入力の補完候補を追加）があります。

Claude Code の挙動を変えられるイベントと API を「何を変えたいか」で引ける一覧と、そのサンプルコードは [14 章](#14-claude-code-の挙動を変更できる-api-一覧とサンプルコード) にあります。

### 出典ページ

| 略称 | URL |
| :- | :- |
| overview | https://code.claude.com/docs/en/plugins/mods/overview |
| create | https://code.claude.com/docs/en/plugins/mods/create |
| events | https://code.claude.com/docs/en/plugins/mods/events |
| api | https://code.claude.com/docs/en/plugins/mods/api |
| interface | https://code.claude.com/docs/en/plugins/mods/interface |
| gallery | https://code.claude.com/docs/en/plugins/mods/gallery |
| test | https://code.claude.com/docs/en/plugins/mods/test |
| troubleshoot | https://code.claude.com/docs/en/plugins/mods/troubleshoot |
| admin | https://code.claude.com/docs/en/plugins/mods/admin |
| reference | https://code.claude.com/docs/en/plugins/mods/reference |
| d.ts | `claude --plugin-dir <mod>` で読み込むと `<mod>/.claude-plugin/types/claude-code/index.d.ts` に書き出される型定義（2.1.292）。行番号はこのファイルのもの |

---

## 1. mod とは何か、他の拡張手段との違い（overview）

mod はプラグインの一種で、`hooks/hooks.json` の `modules` キーが hooks module（JS/TS ファイル）を指していることで mod になります。Claude Code は自身が何かをする直前にイベントを発火し、hook はその前に割り込みます。

| | mod | 設定フック | skill | MCP サーバー |
| :- | :- | :- | :- | :- |
| 実体 | Claude Code プロセス内で呼ばれる関数 | ライフサイクルで実行されるシェルコマンド / HTTP / prompt | Claude が読む `SKILL.md` | ツールを提供する外部プロセス |
| 変えられるもの | ツール呼び出し、プロンプト、コマンド、ターン、UI 描画 | ツール呼び出しやプロンプトの可否、引数と結果、追加コンテキスト | Claude の知識と手順 | 使えるツール |
| UI 描画 | できる | できない | できない | できない |
| 書く言語 | JS / TS | 任意のスクリプト + `settings.json` | Markdown | 任意 |

mod にしかできないこととしてドキュメントが挙げるのは、操作できる UI の描画、Claude Code 自身の UI の差し替え、ツール呼び出しやモデルリクエストへの介入（保留してユーザーに質問、ツールを実行せずに回答、別モデルへ送る）、Claude のターンを介さずに即時実行されるコマンド、hook 間での変数共有の 5 点です。

### 動作する場所

| 実行環境 | hook が動く | 描画が表示される |
| :- | :- | :- |
| ターミナルの `claude`（エディタ内蔵ターミナル、JetBrains プラグイン含む） | はい | はい |
| Desktop アプリの Code タブ（WSL セッション以外） | はい | はい（ターミナル専用要素を除く） |
| Desktop の WSL セッション | いいえ（プラグイン非対応） | いいえ |
| VS Code 拡張のチャットパネル | はい | いいえ |
| `claude -p`、Agent SDK | はい | いいえ |
| Remote Control（claude.ai / モバイル） | 手元のセッションで動く | 手元のターミナルに表示 |
| クラウドセッション | クラウドに届くプラグインなら動く | いいえ |

必要バージョンはターミナルが v2.1.287 以降、Desktop 同梱版が v2.1.286 以降です。

### mod が触れられる範囲（セキュリティ）

mod はサンドボックス化されず、ユーザー権限で動きます。ファイルの読み書き、プロセス起動、ネットワーク、環境変数と設定ファイル（API キーを含む）の読み取り、全プロンプトとツール呼び出しの閲覧と書き換え、ユーザーとしてのプロンプト送信、他セッションへのメッセージ送信、ユーザーに確認する前のツール承認、ユーザーのプランや API キーでのモデル呼び出しができます。sandboxing を有効にしても隔離されるのは Claude が実行する Bash だけで、mod が起動したプロセスは対象外です。

---

## 2. ファイル構成と hook 関数（reference, create）

### ファイル

| ファイル | 必須 | 内容 |
| :- | :- | :- |
| `.claude-plugin/plugin.json` | はい | プラグインのマニフェスト。mod 固有の必須フィールドはない |
| `hooks/hooks.json` | はい | `"modules": ["./register.js"]`（1 パスのみ）。設定フックを `hooks` に同居させてもよい |
| hooks module | はい | `register(on, options)` を export する ES module。拡張子は `.js .mjs .cjs .jsx .ts .mts .cts .tsx` |
| `types/index.d.ts`（マニフェストの `types` で指定） | `$.state` を使う、または API に名前空間を追加する場合 | `PluginState` の宣言など |
| `*.test.ts` / `*.test.tsx` | いいえ | `claude plugin test` が実行するテスト |

Node.js もバンドラーもビルドも不要で、Claude Code が `.js` / `.ts` を直接読み込みます。`register` の `options` には、マニフェストの `userConfig` に宣言した値（既定値を補完済み）が入ります。

### hook 関数の引数

`on(イベント名, [matcher], async ($, e, next) => ...)` で登録し、戻り値の `.catch(handler)` でエラーハンドラを付けられます。

| 引数 | 内容 |
| :- | :- |
| `$` | mods API。`$.fs.read(...)` のように必ず「名前空間.メソッド」で書く |
| `e` | イベント入力。深く freeze されたプレーンデータで、変更するにはコピーを `next` に渡す |
| `next(e)` | ミドルウェアの次段。後続 mod の hook、最後に Claude Code 本来の動作を実行し、結果を返す |
| `next.signal` | イベントが放棄されたとき（ユーザーの中断など）に abort する `AbortSignal` |
| `next.origin` | イベントの発火元 `{ plugin, tier }`。Claude Code 自身は `{ plugin: 'engine', tier: 'core' }` |
| `next.budget` | 制限時間。`ms` が全体、`remainingMs` が残り |
| `next.to(e, tier)` | 後段の tier（`append` / `builtin` / `core`）へ飛ぶ。`prependPlugins` か `appendPlugins` にある mod だけが使える |
| `next.error`, `next.called` | `.catch` ハンドラ内でのみ有効。`kind` は `throw` か `timeout` |

`turn.step` と `process.spawn` の hook は async generator、それ以外は async 関数です。

---

## 3. イベント（events, reference）

### hook がイベントに対してできる 3 つのこと

- **観察**: 処理をして `return next(e)`。後処理なら `const r = await next(e)` の後に処理して `r` を返す。
- **書き換え**: `next({ ...e, text: ... })` のようにコピーを渡す。結果側を書き換えることもできる。
- **回答**: `next` を呼ばずに結果オブジェクトを返す。後続の mod と Claude Code 本来の動作は実行されない。

### matcher（絞り込み）

`on` の第 2 引数はイベントのフィールドとの照合条件で、全フィールドが一致したときだけ hook が動きます。値は文字列、配列（いずれか一致）、正規表現のどれでも書けます。

```javascript
on('tool.call', { tool: 'Bash' }, hook)
on('tool.call', { tool: ['Edit', 'Write'] }, hook)
on('tool.call', { tool: /^mcp__github__/ }, hook)
```

イベント名には `'classic.*'`（全設定フックイベント）と `'*'`（テレメトリ以外の全イベント）のワイルドカードが使えます。同じイベントを matcher なしで 2 回登録すると、モジュールの読み込みが失敗します。

### ツール

| イベント | 発火タイミング | hook が返せるもの |
| :- | :- | :- |
| `tool.call` | ツール実行直前（サブエージェントと MCP ツールを含む） | `next(e)`、`{ deny: 理由 }`、`{ result }` |
| `tool.check` | 許可判定時。`tool.call` と `PreToolUse` の後。`next(e)` はルール・権限モード・フックが出した判定を返す | `{ decision }`（`allow` / `ask` / `deny`） |
| `tool.describe` | 各ツールの説明を Claude に初めて送るとき | `{ description }`。`isDeferred: true` でツール検索の後ろに回す、`false` で最初から読み込む |

`tool.call` でできること:

- 引数を変えて `next` に渡す。
- `isError` を見て `next(e)` をもう一度呼び、再試行する。
- `{ result }` を返してツールを実行させない（権限プロンプトも出ない）。
- `await $.ui.ask(...)` で呼び出しを保留し、ユーザーに選ばせる。

`$.ui.ask` で待っている時間は hook の制限時間に含まれません。自分で作った Promise を待つ時間は含まれ、hook がタイムアウトすると skip されて保留中のコマンドが実行されます。

### プロンプトと Claude が読むもの

| イベント | 発火タイミング | hook が返せるもの |
| :- | :- | :- |
| `prompt.submit` | プロンプト送信時 | `next({...e, text})`（書き換え、transcript にも反映）、`next({...e, context})`（Claude だけが読む追記）、`{ drop: 理由 }` |
| `prompt.fill` / `prompt.suggest` | プロンプト欄に下書き、または薄い提案が入る直前 | テキストを変えた `next(e)` |
| `prompt.edit` | ユーザーがプロンプト欄を編集したとき（制限時間 50ms） | `next(e)` |
| `prompt.compose` | システムプロンプトの組み立て時 | `{ sections }`（`{ id, text, scope }` の送信順リスト） |
| `prompt.section` | システムプロンプトの名前付きセクションごと | `{ text }`、`{ text: null }` で削除 |
| `prompt.context` | 会話ごとに 1 回、最初のメッセージに付くコンテキスト | `{ blocks }` |
| `prompt.attachment` | Claude Code が独自メッセージ（リマインダーなど）を足すとき。`e.type` が種類、`e.detail` が元の事実 | `{ text }`、`{ text: null }` で削除 |
| `prompt.mention` | @メンションされたファイルを読む直前（v2.1.290 以降） | `next({...e, path})` で別ファイルを読ませる、`{ deny }` |
| `skill.prompt` | skill の本文を展開するとき | `{ text }` |
| `attribution.text` | コミットや PR の attribution 文を組み立てるとき | `{ text }` |
| `prompt.autocomplete` | **ドキュメント未記載（d.ts:4123, 8173）**。入力中にカーソル位置のトークンごとに発火 | `{ suggestions: [{ text, label?, description? }] }`。Claude Code 自身の候補の下に追加される |

リクエストごとに変わるテキストをこれらの hook で差し込むと、プロンプトキャッシュが無効になります。

### コマンドと設定

| イベント | 発火タイミング | hook が返せるもの |
| :- | :- | :- |
| `command.run` | コマンド実行直前 | `{ text }`（transcript に表示され Claude も読む）、`{}`（表示なし）、`next(e)` |
| `command.describe` | コマンド一覧の各行 | `{ description, argumentHint, isHidden }` |
| `config.set` | `/config` の行が変わる直前 | `next({...e, value})`、`{ deny }` |
| `config.describe` | `/config` の各行 | `{ label, description, isHidden }` |

### ターン

| イベント | 発火タイミング | hook でできること |
| :- | :- | :- |
| `turn.start` | ターン開始 | 観察。`e.turnId` で他の 2 イベントと対応づける |
| `turn.step` | モデルへの 1 リクエスト直前（ツールを使うターンでは複数回）。サブエージェントでは `e.agentId` あり | async generator で `yield* next(e)`。`next({...e, model})` で別モデルへ、`next({...e, effort})`、モデルを呼ばずに回答 |
| `turn.complete` | ターン終了（中断時は `e.isAborted`）。`e.answer`、`e.durationMs`、`e.usage` | 観察、`{ text }` で回答の下に 1 行表示 |

`turn.step` の結果 `result.usage` には `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` と応答したモデルが入ります。

### セッション

| イベント | 発火タイミング | hook が返せるもの |
| :- | :- | :- |
| `session.start` | mod ごとに 1 回、最初のプロンプト前と、その mod のリロード後。`/clear` `/resume` `/branch` の後は発火しない | `next(e)` |
| `session.end` | 終了時と `/clear` `/resume` `/branch` 実行時。`e.reason` は `clear` `resume` `logout` `prompt_input_exit` `other` | `next(e)` |
| `session.compact` | compaction 直前 | `{ skip: 理由 }` で compaction を止める |
| `session.receive` | 他のエージェントやセッションからメッセージが届いたとき（Claude が読む前） | `{ consumed: 理由 }` で Claude に渡さない |
| `session.send` | メッセージ送信直前（SendMessage ツールまたは mod から） | `{ isDelivered: false, reason }` |
| `session.append` | 会話に保存される各行（プロンプト、応答ブロック、ツール結果、通知）の保存前 | `next({...e, message})` で `content` を書き換え |
| `session.attach` / `session.detach` | 別アプリがセッションに接続・切断したとき | `next(e)` |
| `session.measure` | 各ターン後と、プラン上限の使用率が変わったとき | `next(e)` |

### サブエージェント

| イベント | 発火タイミング | hook が返せるもの |
| :- | :- | :- |
| `agent.offer` | サブエージェント型を Claude に提示するとき | `{ isOffered: false }` で隠す |
| `agent.spawn` | サブエージェントまたは agent team の teammate の起動直前（teammate なら `e.isTeammate`） | `next({...e, model})` でモデルを選ぶ、`{ deny }` |

### UI

| イベント | 発火タイミング |
| :- | :- |
| `ui.render` | render site を描く直前 |
| `ui.resolve` | mod 読み込み時に、アプリ・render site・mod の組ごとに 1 回。結果は `$.ui.resolve(e)` が返す要素表 |
| `ui.press` / `ui.input` / `ui.select` | mod が描いた `Button` / `Input` / `Select` が操作されたとき（描いた mod のコールバックより先に、他の mod の hook が動く） |
| `ui.focus` / `ui.scroll` | フォーカスやスクロール位置が変わる直前 |
| `ui.close` | ペインが閉じる直前。`e.origin.kind` は `plugin` `person` `unload` |
| `ui.message` | `Client` 要素が mod にデータを送ったとき |
| `ui.fault` | `Client` の読み込み・描画・実行が失敗したとき（v2.1.289 以降） |

### 他の mod への介入

| イベント | 発火タイミング | hook が返せるもの |
| :- | :- | :- |
| `plugin.register` | 他の hooks module が読み込まれる直前。`e.uses` に、その mod が使うイベント・API 呼び出し・環境変数・state が入る | `{ refuse: 理由 }` で読み込みを拒否 |
| `engine.create` | その mod に渡す mods API を組み立てるとき | 名前空間を追加した API。`user` tier 以外の mod は名前空間を取り除くこともできる |

### テレメトリ

`telemetry.log` と `telemetry.mark` は `{ to: 'collector' }` の matcher が必須で、ないと `claude plugin validate` が失敗します。`*` にはマッチしません。返せるのは `next(e)` と `{ deny }` です。

### 設定フックイベント（`classic.*`）

設定ファイルのフックイベントは、それぞれ `classic.<イベント名>` という名前で mod からも扱えます。`e` は設定フックが stdin で受け取る JSON と同じです。型定義から読み取れる 33 種は次のとおりです。

`ConfigChange CwdChanged DirectoryAdded Elicitation ElicitationResult FileChanged InstructionsLoaded MessageDisplay Notification PermissionDenied PermissionRequest PostCompact PostModelSwitch PostToolBatch PostToolUse PostToolUseFailure PreCompact PreModelSwitch PreToolUse SessionEnd SessionStart Setup Stop StopFailure SubagentStart SubagentStop TaskCompleted TaskCreated TeammateIdle UserPromptExpansion UserPromptSubmit WorktreeCreate WorktreeRemove`

型定義（d.ts:1224）によれば、これらは設定フックが 1 つも設定されていなくても発火します。`classic.PreToolUse` だけは `e` の形が異なり、ツール呼び出しの envelope になります（d.ts:1236）。

`/clear` `/resume` `/branch` の後に値を読み直すには `classic.SessionStart` を使い、`{ source: ['clear', 'resume', 'fork'] }` で絞ります（interface）。

### mods API 呼び出しイベント

mods API の各メソッドは、それ自体がイベントでもあります（`fs.read`、`model.complete`、`ui.open` など）。チェーンの前段にいる mod は、後段の mod の呼び出しを観察・書き換え・拒否（`{ deny }`）・代わりに回答（`{ value }`）できます。組織がポリシー mod で mod の行動を制限する仕組みはこれです。

例外として、`$.ui.ask` は独立したイベントではなく、`AskUserQuestion` ツールの `tool.call` として実装されています（d.ts:2420、test の stub 表）。`$.ui.ask` に介入するには `tool.call` を `{ tool: 'AskUserQuestion' }` で捕まえます。

### mod の実行順

同じイベントの hook は 1 本のミドルウェアチェーンになり、先頭の mod が一番外側です。先頭の mod は最初にイベントを見て最後に結果を見るので、後続の mod を走らせるかどうかを決められます。

1. 組み込みガード `sec-default@builtin`（読み込まれる環境のみ）、`prependPlugins` の mod、`appendPlugins` に入っていない組織の mod
2. ユーザーがインストールした mod（manifest の `dependencies` に挙げた mod より先に動く）
3. `appendPlugins` の mod
4. その他の組み込み mod

1 つのモジュール内では、`on` を呼んだ順に動きます。

設定フックの `PreToolUse` が入る位置:

- managed settings の `PreToolUse` は全 mod の `tool.call` より前に動き、そこでのブロックは最終決定になる。mod が呼び出しを書き換えた場合は、書き換え後の呼び出しに対してもう一度動く（admin）。
- その他の設定ファイルやプラグインの `PreToolUse` は、最後の mod が `next` を呼んだ後に動く。mod が `next` を呼ばずに回答すると、これらは動かない。
- `tool.check` はその後で発火するので、後者のフックがブロックした呼び出しを承認できる。

### hook が失敗したとき

`.catch` がない hook が throw・タイムアウト・形の違う結果を返した場合、`next` を呼ぶ前の失敗なら skip されて次段が代わりに動き（fail open）、`next` の結果が出た後の失敗ならその結果が採用されます。ブロック系の hook を fail closed にするには、`.catch` で `{ deny }` を返します。`.catch` の制限時間は 1 秒です。

---

## 4. mods API（api, reference, d.ts）

「説明の厚さ」列は、ガイドに使用例がある（ガイド）か、リファレンス表に名前だけある（名前のみ）かの区別です。名前のみのメソッドの説明は型定義のコメントから補っています。

| 名前空間 | メソッド | 説明の厚さ | 要点 |
| :- | :- | :- | :- |
| `$.plugin` | `name`, `root` | 名前のみ | 自プラグインの名前とディレクトリ |
| `$.ui` | `resolve` `invalidate` `open` `close` `toast` `status` `log` `blit` | ガイド | 描画（5 章） |
| `$.ui` | `ask` | ガイド | AskUserQuestion ダイアログで質問し、選ばれたラベルを返す。却下時と `-p` では reject |
| `$.ui` | `panes` `focus` `scroll` `copy` `selection` `notice` | 名前のみ | d.ts:2336〜2558。`panes` は自分の開いているペイン一覧（リロード後も見える）、`focus` / `scroll` は DOM の `focus()` / `scrollIntoView` 相当、`copy` はクリップボードへの書き込み、`selection` はユーザーがマウスで最後に選択したテキストと行、`notice` は開いているダイアログの下に 1 行表示 |
| `$.command` | `register` `run` `list` | ガイド（`register`） | `immediate: true` で Claude の作業中でも実行できる。組み込みと同名は throw |
| `$.tool` | `register` `call` `check` `list` | ガイド（`register`） | Claude には `mcp__<plugin>__<name>` として見える。処理は `tool.call` hook に書く |
| `$.agent` | `register` `spawn` `list` | 名前のみ | d.ts:3185。`register` で `<plugin>:<name>` のサブエージェント型を定義（agent ファイルと同じフィールド）。`spawn` で起動 |
| `$.model` | `complete` | ガイド | 会話履歴なしで 1 回問い合わせる。API 失敗では reject せず `isAnswered` / `reason` で返す。`maxTokens` 既定 1024 |
| `$.model` | `fork` | ガイド（短い） | 現在の会話の上で 1 問だけ尋ねる。同じモデル・同じシステムプロンプトなのでキャッシュが効く。ツールはすべて拒否される（d.ts:2609） |
| `$.model` | `classify` | 名前のみ | d.ts:2628。`text` を `labels` のどれかに分類する。該当なしなら `undefined` |
| `$.prompt` | `submit` | ガイド | アイドル時に新しいターンを始める。既定では mod 名を名乗る一文の後に置かれ、`asUser: true` でユーザー本人の発言として送る |
| `$.prompt` | `read` `fill` `suggest` `compose` | 名前のみ | `read` は入力欄の下書きとカーソル、`fill` は下書きの置換・追記・挿入（d.ts:2932, 2946） |
| `$.turn` | `abort` | 名前のみ | d.ts:2903。`turn.start` で受け取った実行中ターンを中断し、実行中のツールも止める |
| `$.session` | `send` `messages` `usage` | ガイド | `send` は SendMessage ツールと同じ配送。`messages()` は最新 4,096 件。`usage()` はコンテキスト使用量・レート上限・コスト |
| `$.session` | `cwd` `root` `model` `turns` `id` `repo` `surfaces` `version` `compact` `append` `authorize` | 名前のみ | `authorize`（d.ts:2885）は Anthropic の認証情報をホスト側に保持し、不透明なハンドルだけを返す。`$.http.fetch(url, { auth })` で first-party ホストにのみ使える。`surface`（単数）は型で非推奨 |
| `$.config` | `list` `set` | 名前のみ | `/config` の行の取得と変更 |
| `$.settings` | `read` | ガイド | マージ済み設定、または `{ source }` 指定で 1 ソース分 |
| `$.env` | `get` `set` | ガイド | 変数名は文字列リテラルで書く。`set` は以後 Claude Code が起動するコマンドと MCP サーバーにも効く |
| `$.fs` | `read` `write` `list` `exists` `stat` | ガイド | 相対パスは作業ディレクトリ基準。`list` は再帰しない。`write` は非アトミック。1 ファイル 4 MiB まで |
| `$.fs` | `ancestors` | 名前のみ | d.ts:3314。CLAUDE.md と同じ方法で、上位ディレクトリの指示ファイルを `@include` 展開込みで読む |
| `$.store` | `get` `set` `delete` `keys` | ガイド | マシン上の全セッションで共有する JSON KV。合計 4 MiB |
| `$.state` | `get` `set`（`claude-code` から `atom` `read` `update` `derive` `memberOf` を import） | ガイド | リアクティブ状態（6 章） |
| `$.clock` | `now` `sleep` `after` `every` | ガイド | `setTimeout` / `setInterval` の代わり。モジュールのリロードで停止する |
| `$.http` | `fetch` | ガイド | `{ status, ok, headers, text }` を返す。組織のネットワークポリシーが適用される |
| `$.process` | `run` `spawn` | ガイド | シェルを通さず argv で起動。`run` は既定 30 秒・最大 10 分。`spawn` は出力をストリームで返し、ループを抜けると子プロセスが終了する |
| `$.mcp` | `call` `connect` | 名前のみ | `connect` は自分のマニフェストにある MCP サーバーだけ接続できる |
| `$.audio` | `play` `speak` | 名前のみ | d.ts:2649, 2663。macOS では `afplay` と `say` を使う。Linux / Windows のターミナルでは何も再生されない |
| `$.telemetry` | `log` `mark` | 名前のみ | 実際に送られるのは Claude Code か組み込み mod が呼んだときだけ |

hooks module には Node.js の API も `setTimeout` もなく、外部へのアクセスはすべて `$` 経由です。`URL`、`TextEncoder`、`AbortController`、`crypto.subtle` などの標準 Web API は使えます。

### ターンを始めずに表示する

| 呼び出し | 表示 |
| :- | :- |
| `$.ui.status(text)` | プロンプトの下に 1 行。変更するまで残る。先頭に `⚠ <mod名>:` |
| `$.ui.toast(text)` | 右上のトースト。既定 4 秒（`timeoutMs` で変更） |
| `$.ui.log(text)` | transcript に薄い行。Claude は読まない。`{ to: 'debug' }` を付けるとデバッグログに出る |

---

## 5. UI 描画（interface, gallery, reference）

`ui.render` hook が要素ツリーを返すと、Claude Code がそれをターミナルか Desktop で描きます。要素は `$.ui.resolve(e)` から取り出します。`.tsx` / `.jsx` のモジュールなら JSX でも書けます。

### render site（描画できる場所）

| site | 内容 | `e.props` | 表示先 |
| :- | :- | :- | :- |
| `Pane` | mod 独自のペイン。広いフルスクリーンでは右サイドバー、それ以外はプロンプト上の枠 | `title` `isFocused` `bodyColumns` `placement` `scroll` `view` | Terminal / Desktop |
| `AbovePrompt` | プロンプト直上の帯。常に存在し、全 mod で共有する | `hasSurvey` `isWorking` `maxRows` `bodyColumns` `scroll` `view` | Terminal / Desktop |
| `UserMessage` / `AssistantMessage` | transcript のメッセージ | テキスト、origin など | Terminal / Desktop |
| `ToolUse` / `ToolResult` / `ToolGroup` | ツール呼び出しの行、結果、折りたたみグループ | ツール名・入力・結果 | Terminal / Desktop |
| `CommandOutput` | コマンドの出力行 | `command` `text` | Terminal / Desktop |
| `AskUserQuestion` | Claude の質問ダイアログ | 質問と選択肢 | Terminal / Desktop |
| `Spinner` | 作業中のアニメーション行 | `word` `message` `suffix` `mode` | Terminal / Desktop |
| `SessionMode` | フッターのモード表示 | `modes` | Terminal / Desktop |
| `PromptHint` | プロンプト下のヒント行 | `isDraft` `isWorking` `hint` | Terminal / Desktop |
| `ToolProgress` | 実行中ツールの進捗行 | `kind` | Terminal のみ |
| `TurnDuration` | ターン終了行 | `word` `durationMs` | Terminal のみ |
| `InfoNotice` | ロゴ下の状態行 | `text` `command` | Terminal のみ |

既存の site に対してできること:

- `next({...e, props: {...}})` で一部だけ変える。
- `next` を呼ばずにツリーを返して置き換える。
- `next(e)` で手を加えない。
- `await next(e)` が返す `{ type: 'engine', ref }` を `Box` に入れ、自分の要素と並べる。

`AskUserQuestion` のツリーは、この参照をちょうど 1 回含み、自分の要素をその上に置く必要があります。満たさない場合は Claude Code 自身のダイアログが描かれます。**権限プロンプトは render site ではないので変更できません。**

帯（`AbovePrompt`）では、ツリーを返すと後続 mod の描画を置き換えます。残すには `await next(e)` の結果を子に含めます。

### 要素

| 要素 | 主な props | Terminal | Desktop |
| :- | :- | :-: | :-: |
| `Box` | flex レイアウト、`gap` `padding` `margin` `width` `height` `borderStyle` `backgroundColor` `position` `hover` | ✓ | ✓ |
| `Text` | `color` `backgroundColor` `bold` `italic` `underline` `strikethrough` `dimColor` `inverse` `wrap` | ✓ | ✓ |
| `Button` | `key` `label` `onPress` `hotkey` `plain` `dimColor` `autoFocus` `action` | ✓ | ✓ |
| `Link` | `href` `label` | ✓ | ✓ |
| `Code` | `source` `language` / `path` `startLine`、`format: 'diff'` で単語単位の差分表示 | ✓ | ✓ |
| `Markdown` | `text`（children ではない）`onLinkPress` `pressableLinks` | ✓ | ✓ |
| `Input` | `key` `label` `placeholder` `value` `submitLabel` `onSubmit` `onInput` `autoFocus` | ✓ | ✓ |
| `Select` | `key` `label` `options` `value` `onSelect` `autoFocus` | ✓ | ✓ |
| `Client` | `module` `key`。別ファイルが描く領域（アニメーション、ポインタ入力用）。mods API は使えず、`ui.message` でデータを送る | ✓ | ✓ |
| `Svg` | SVG 文書（最大 131,072 文字） | | ✓ |
| `Raster` | 色付き文字セルのグリッド（最大 512 列 × 256 行）。`cells` は（コードポイント, 前景色, 背景色）の uint32 を base64 にしたもの | ✓ | |
| `Image` | PNG / RGBA（最大 2 MiB）またはファイルパス | ✓ | |

使えない要素や props を含むツリーは検証で落ち、Claude Code が自分の描画に戻します。`--plugin-dir` のセッションでは `ui.render (Pane) refused: ...` の行が transcript に出ます。`Raster` や `Image` は `$.ui.blit` で、`ui.render` を再実行せずに差し替えられます（最大 120 回/秒受け付け）。

### ペインの開閉と配置

`$.ui.open({ id, title?, focus?, closeOnEscape?, holdToasts?, rows?, columns? })` で開き、`$.ui.close({ id })` で閉じます。`focus`、`closeOnEscape`、`holdToasts` は `true` しか受け付けず、`false` を渡すと throw します。条件付きにしたい場合はフィールドごと省きます。

- ユーザーの操作（コマンドやボタン）から開いた場合は、どの幅でも表示される。
- mod が自発的に（タイマーや `turn.start` から）開いた場合は、144 列以上でないと表示されない。ユーザーが一度自分で開いた後は 110 列でよい。表示されなければ `isPlaced: false` と `reason` が返る。

### キーボード

mod がキーボードを直接読むことはなく、フォーカスを持つときだけ自分のコントロールにキーが届きます（帯の数字 hotkey は例外）。フォーカスを得る方法は、`focus: true` で開く（プロンプトが空のときだけ有効）、Ctrl+X → Tab、クリックの 3 つです。

| キー | 動作 |
| :- | :- |
| Tab / ↑↓ | コントロール間の移動。内容が収まらない場合はスクロール |
| Enter | ボタンを押す、Input を送信、Select で選ぶ |
| hotkey（数字 1 文字か小文字 1 文字） | そのボタンを押す。Input にフォーカスがある間は Input に入る |
| PgUp / PgDn / Home / End | スクロール |
| Ctrl+X → 矢印 | ペインのサイズ変更 |
| Ctrl+X → X | ペインを閉じる |
| Esc | フォーカスをプロンプトに戻す（`closeOnEscape` なら閉じる） |

Tab と矢印キーは別の用途に割り当てられません。`Button` の `action` に Claude Code のキーバインド操作名を指定すると、ユーザーのそのキーバインド（コード（chord）か修飾キー付きの場合）でボタンが押されます。

### 再描画

Claude Code が自分から `ui.render` を再実行するのは、site の props が変わったときとターミナル幅が変わったときだけです。mod 側のデータが変わったら `$.ui.invalidate('ui.render')` を呼びます。上限は 10 回/秒（ターミナルで表示中のペイン、展開した帯、ヒント行は 30 回/秒）で、それより速い呼び出しは 1 回にまとめられます。定期的な更新は `session.start` で `$.clock.every` を仕掛けて行います。

---

## 6. 状態の保持（interface）

| 置き場所 | 寿命 | 用途 |
| :- | :- | :- |
| モジュール変数 | モジュールのリロードまで（開発中は保存のたび） | 失ってもよい値 |
| `$.state` | セッション終了、または `/clear` `/resume` `/branch` まで。リロードでは消えない | 描画が依存する値。書き込むと、その値を読んだ site が自動で再描画される |
| `$.store` | mod が削除するか、`cleanupPeriodDays` の間どのセッションも触らなかったときまで。`~/.claude/plugins/store/` の JSON | 設定、履歴、次回も残したい値 |

`$.state` を使うには、`types/index.d.ts` に `declare module 'claude-code' { interface PluginState { '<plugin名>': {...} } }` を書き、マニフェストの `types` でそのファイルを指します。`atom({ plugin, key }, 既定値)` の `plugin` と `key` は文字列リテラルで書く必要があります。`ui.render` からは読むだけで、書き込みはコールバックや他のイベントの hook から行います。

`$.store` は全セッションで共有され、`get` してから `set` するまでの間はアトミックではありません。項目ごとにキーを分けるか、書き込む直前に読み直すことで競合を減らします。

---

## 7. 作成と開発ループ（create）

### Claude に書かせる

組み込み skill の `plugin-authoring` を使います。依頼すると Claude が自動で読み込み、`/plugin-authoring` で明示的に読み込むこともできます。

- 生成先は `~/.claude/dev-mods/<セッションID>/<mod名>/`。`~/.claude` は保護パスなので、`default` と `acceptEdits` モードではファイルごとに承認が必要。
- 最初のファイルを保存したときにホットリロードを有効にするか聞かれる。有効にすると、ターン終了時に読み込まれ、以後変更のあったターンの終わりに再読み込みされる。
- 読み込まれないのは、承認できない状況（`-p`、`dontAsk`）、信頼していないワークスペース、`--safe-mode` / `--bare` / `disableAllHooks` / 組織ポリシーのいずれか。
- 生成されたディレクトリは `cleanupPeriodDays` を過ぎると削除されるので、残すなら別の場所にコピーして `--plugin-dir` で読み込む。

### 自分で書く

`claude --plugin-dir ./mod` で、そのセッションだけ読み込みます。ファイルを保存すると hooks module がホットリロードされ、`register` が再実行されます（モジュール変数は初期化されます）。保存した内容が壊れていた場合は「reload failed, the previous version stays loaded」と出て、直前の動くバージョンが残ります。インストール済みのプラグインはバージョンごとにキャッシュされるので、開発は必ず `--plugin-dir` で行います。

### 型定義の自動生成

`--plugin-dir` で読み込むか、Claude が mod を書くと、`.claude-plugin/types/` に次のファイルが書き出されます。

| パス | 内容 |
| :- | :- |
| `claude-code/index.d.ts` | 全イベントの入力と結果、全 API、surface ごとの要素。各メソッドの説明と例付き |
| `claude-code-tools/index.d.ts` | 組み込みツールの入出力（`e.tool === 'Bash'` で型が絞り込まれる） |
| `claude-code-mcp/index.d.ts` | 最後に保存したときに接続していた MCP ツールの入力 |
| `<依存プラグイン名>/index.d.ts` | `dependencies` に挙げたプラグインが追加した API |
| `tsconfig.json` | hooks module 向けの設定。mod のルートに tsconfig がなければ、これを extends するものが追加される |

ドキュメントと食い違う場合は、このファイルを優先するよう公式が明記しています。

### `claude plugin validate` と静的解析の制約

`hooks:`（イベントと matcher）、`calls:`（API 呼び出し）、`env reads:/writes:`、`state reads:/writes:` を出力します。`--strict` で警告もエラー扱い、`--json` で機械可読な出力になります。静的解析が読めない書き方をすると読み込みが拒否されます。

- `$.ns.method(...)` と省略せずに書く。`$` を変数に入れる、分割代入する、計算したキーで添字アクセスすると失敗する（`$.ui is used as a value`）。
- `$` はトップレベルの関数にだけ渡せる（`calls:` に `(via fn)` と表示される）。メソッド、hook 内で定義した関数、import した関数には渡せない。例外は `$.state` 用の `read` / `update`。
- `on` のイベント名は文字列リテラルで書く。変数やループは不可。
- `register` 内で `on` をシャドウしない。
- import はプラグイン内の相対パスと、`claude-code`（型とヘルパー）だけ。`import()` と `require` は不可。
- プラグイン名が Anthropic のものに見える場合（`claude-` で始まるなど）は validate で失敗する。

---

## 8. テスト（test）

`claude plugin test [dir]` が `*.test.ts` / `*.test.tsx` を実行します。セッションもサインインもネットワークも不要で、失敗すると終了コード 1 を返すので CI で使えます。`import { expect, test, mock, tier } from 'claude-code/testing'` を使います。

- テスト関数は `($, on)` を受け取る。`$` は Claude Code 役で、`$.tool.call(...)`、`$.command.run(...)`、`$.prompt.submit`、`$.session.start`、`$.turn.complete`、`$.classic.*` などが対応するイベントを発火する。
- `on` で stub を登録する。API 呼び出しの stub は `{ value }`（または `{ deny }`）を返し、イベントの stub はそのイベントの結果を返す。stub は `$` を最初に呼ぶ前に登録する。
- `session.start` は自動では走らないので、必要なら自分で発火する。
- `next(e)` を返す `ui.render` hook には、プレーンデータの要素を返す stub が必要。
- `turn.step` の stub は async generator で書く。
- `mock.clock(on)` は時間を `advance` / `set` / `settle` / `sleep` で操作できる時計。`mock.store(on, 初期値)` と `mock.env(on, 変数)` もある。
- 描画のテストは `$.ui.mount({ ...site, surface })` で行い、返ったハンドルの `press` / `input` / `select` / `find` / `unmount` を `key` で指定して使う。描画結果の見た目ではなく、ツリーとその検証を確認する。
- ポリシー mod のテストは、`tier('prepend')` と `test(name, { plugins: [インライン mod] }, fn)` で他の mod を相手にする。
- `expect` は `toBe` `toEqual` `toMatch` `toMatchObject` `toContain` `toBeDefined` `toBeUndefined` `toThrow` と `.not` を持つ。テスト 1 件の上限は既定 5 秒。

---

## 9. トラブルシュート（troubleshoot）

失敗した mod や hook は skip され、セッションは続きます。そのため、壊れた mod は「何もしない mod」に見えます。

- **メッセージの出る場所**: ホットリロードしているセッションでは transcript、それ以外の対話セッションでは `--debug` のログ、`-p` では stderr。
- **mod が読み込めるかの確認**: mod のないディレクトリで `claude plugin test` を実行する。`no hooks module to load` なら読み込める状態、`turned off here` なら設定が止めている、`turned off in this process` なら Anthropic がリモートで停止している。
- **主な拒否理由**: `disableAllHooks in managed settings`、`only managed plugins and built-in plugins run`、`--bare`、同名プラグインの重複、`userConfig` の検証失敗、トップレベルコードの throw。
- **組み込みガードのメッセージ**: `allowManagedModsOnly`、`tried to lift a deny rule`、`deny rules ... could not be checked`。
- **実行時**: `hook skipped: threw/timeout/...`、`no command.run hook answered it`、`it crashed the hooks worker`（インストール済み mod は 1 本のワーカースレッドを共有していて、ワーカーを止めた mod がアンロードされる）。3 回クラッシュして原因を特定できないと、組み込み以外の全 mod が `/reload-plugins` までオフになる。
- **auto モード**: hook が分類器の審査後に入力を書き換えると、`a hook changed this call's input after the model wrote it` で拒否される。
- **デバッグログ**: 読み込みに成功した行は `hooks module first-mod@inline loaded (worker, environment 2, tier user); events: ...` の形になる。

---

## 10. 組織での管理とセキュリティ（admin）

### 既定の動作

- mod は有効。許可されたマーケットプレイスからのインストールと `--plugin-dir` での読み込みができる。
- managed settings があるマシン、または Team / Enterprise プランでサインインしたユーザーでは、組み込みガード `sec-default@builtin` がユーザーの mod より先に読み込まれる。ユーザーはこれを止められない。
- ガードは、managed hooks の入力と判定、システムプロンプト、managed の CLAUDE.md、mod が読む設定、managed MCP サーバーのツールと説明を、ユーザーの mod から守る。それ以外は制限しない。
- ガードが読み込まれる環境では、`deny` ルールで拒否される呼び出しをユーザーの mod は承認できない。ただしこれは Claude のツール呼び出しにだけ適用され、mod 自身の `$.fs` と `$.process` には適用されない（`Read(.env)` を deny にしても `$.fs.read` では読める）。
- `ask` ルールや非 managed の `PreToolUse` ブロックは mod が覆せる。auto モードで mod が承認した呼び出しは、分類器のチェックなしで実行される。
- `$.http.fetch` には組織のネットワークポリシーが適用されるが、`$.process.run` で起動したプログラムには適用されない。

### ポリシーの選択肢

| やりたいこと | 設定 |
| :- | :- |
| インストール済み mod を止め、フックは残す | ガードの `allowManagedModsOnly` |
| mod もフックも全部止める（managed のフックも含む） | `disableAllHooks: true` |
| 組織の mod だけを許可 | `allowManagedModsOnly` + 組織の mod を正しく配備 |
| 承認したマーケットプレイスの mod だけ許可 | マーケットプレイス制限 + `disableSideloadFlags`（`--plugin-dir` / `--plugin-url` / `--agents` / `--mcp-config` を拒否） |
| 何でも許可し、自作のポリシー mod で検査 | ポリシー mod を `sec-default@builtin` と一緒に `prependPlugins` へ |

ガードのオプションは managed settings の `pluginConfigs["cc-plugin-sec-default@builtin"].options` に書き、`allowManagedModsOnly` と `allowModsToOverrideDenyRules` があります。managed settings 以外に書いても効きません。managed settings を読めない場合、ガードはユーザーの mod をすべて拒否します（fail closed）。

### 組織の mod として扱われる条件

次の 3 つをすべて満たす必要があります。

- managed の `enabledPlugins` で有効になっている。
- マーケットプレイスが managed settings で、ユーザーのマシン上のディレクトリとして絶対パスで指定されている。
- プラグインが相対パスで登録され、その場所から直接読み込まれる。

GitHub、git、URL、npm から取得してキャッシュにコピーされたプラグインは、ユーザーの mod として扱われます。`prependPlugins` を設定すると既定の並びが置き換わるので、ガードを残すには `sec-default@builtin` を明示的に含めます。

### ポリシー mod

`plugin.register` で `e.tier` と `e.uses.calls` を見て `{ refuse }` を返せば、その mod の読み込みを拒否できます。`fs.write` のような API 呼び出しイベントに hook すれば、他の mod の呼び出しを監査・拒否できます。`plugin.register` の hook が throw すると fail open になるので、`.catch` で拒否を返して fail closed にします。`--safe-mode` の場合と、ワーカーが 3 回クラッシュした場合は、組織の mod も止まります。

### インストール前のレビュー

`claude plugin validate ./some-mod` の `hooks:` と `calls:` を確認します。注意が必要なのは次の呼び出しとイベントです。

- **呼び出し**: `$.fs.*`、`$.process.*`、`$.http.fetch`、`$.env.*`、`$.settings.read`、`$.mcp.call`、`$.model.complete`、`$.prompt.submit`、`$.session.send`
- **イベント**: `tool.call`、`prompt.submit`、`session.append`、`ui.render{component=AskUserQuestion}`、`tool.check`

---

## 11. 制限値・設定・コマンド（reference）

### 制限値

| 項目 | 値 |
| :- | :- |
| 1 イベントあたりの hook 実行時間（`next` と API 呼び出しの待ち時間は除く。ただし `$.clock.sleep` は含む） | 10 秒（`prompt.edit` は 50ms） |
| `.catch` ハンドラ | 1 秒 |
| 全 `session.end` hook の合計 | SessionEnd フックの予算（既定 1.5 秒） |
| `$.process.run` | 既定 30 秒、最大 10 分 |
| `$.model.complete` の `maxTokens` | 既定 1024、最大 64,000 またはモデルの出力上限 |
| `$.fs.read` / `write` | 1 ファイル 4 MiB |
| 1 ツリーのテキスト | 先頭 100,000 文字まで描画 |
| `$.store` | 合計 4 MiB |
| `$.session.messages()` | 最新 4,096 件 |
| 再描画 | 10 回/秒（表示中のペイン、展開した帯、ヒント行は 30 回/秒） |
| 自発的に開いたペイン | 144 列以上（ユーザーが一度開いた後は 110 列） |
| コマンド・ツール・サブエージェント型・ペインの名前 | 英数字、`_`、`-` で 64 文字まで |

### 設定と環境変数

| 名前 | 読まれる場所 | 内容 |
| :- | :- | :- |
| `CLAUDE_CODE_PLUGIN_DIRS` | 環境変数、または `settings.json` の `env` | `--plugin-dir` を渡せないアプリ向け。`:` 区切り（Windows は `;`） |
| `CLAUDE_CODE_PLUGIN_DIR_WATCH` | 環境変数 | `1` で、長時間動く非対話セッションでも保存時にリロードする |
| `prependPlugins` / `appendPlugins` | managed settings（条件付きでユーザー設定） | 実行順 |
| `allowManagedModsOnly` / `allowModsToOverrideDenyRules` | managed settings のガードオプション | 上記 10 章 |
| `allowManagedHooksOnly` | managed settings | 組織外のフックとインストール済み mod を止める |
| `disableAllHooks` | 任意の設定ファイル | managed なら全部、ユーザー設定なら組織管理分以外を止める |
| `disableSideloadFlags` | managed settings | サイドロード用フラグを拒否 |
| `pluginConfigs` | ユーザー / managed settings | `userConfig` の値。`--plugin-dir` の mod は `<name>@inline` で指定 |

`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` は v2.1.287 以降無視されるので、`0` にしても mod は止まりません。

### コマンド

`/plugin`（`N mod active · 名前` の行が出る）、`claude plugin validate [--strict] [--json]`、`claude plugin test`、`claude --plugin-dir`（複数指定可）、`/reload-plugins`、`--safe-mode`、`--debug` / `--debug-file`。

---

## 12. 組み込み mod とサンプル（overview）

| `/plugin` での名前 | 内容 | 止め方 |
| :- | :- | :- |
| `cc-plugin-agents-md` | `AGENTS.md` をプロジェクト指示として読む | `/plugin` で無効化 |
| `cc-plugin-diff` | `/diff` のペインを担当 | `/plugin` で無効化（組み込み版の `/diff` に戻る） |
| `cc-plugin-plugin-authoring` | mod 作成用の skill（mod のコードは持たない） | `/plugin` で無効化 |
| `cc-plugin-sec-default` | 組織管理分を守るガード | 止められない |
| `cc-plugin-telemetry` | 分析レコードの送信 | `/plugin` で無効化、または `DISABLE_TELEMETRY` |
| `cc-plugin-you-should-know` | サイドエージェントが作業を見張り、気づいたことをプロンプト上に出す。既定は無効 | `/plugin enable cc-plugin-you-should-know@builtin` で有効化 |

`disableAllHooks`、`--bare`、`--safe-mode` は組み込み mod を止めません。ソースは https://github.com/anthropics/claude-code/tree/main/mods （`diff` `agents-md` `sec-default` `telemetry`）で公開されています。サンプルは https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods の `token-weather`（コンテキスト使用量の予報を帯に表示）、`blast-radius`（危険なシェルコマンドを保留し、影響を表示して確認ボタンを出す）、`replay-theater`（`/replay` で直前ターンの編集を順に再生）です。

---

## 13. ドキュメントと型定義（2.1.292）の差異・矛盾

| 項目 | ドキュメント | 型定義 / 実測 |
| :- | :- | :- |
| `prompt.autocomplete` | 記載なし | 存在する（d.ts:4123）。入力補完の候補を追加するイベント |
| `$.ui.ask` のイベント | 「全 API メソッドはイベントでもある」（reference） | `ui.ask` というイベントキーはなく、`AskUserQuestion` の `tool.call` として実装されている（d.ts:2420） |
| `classic.*` の発火条件 | 記載なし | 設定フックが 1 つもなくても発火する（d.ts:1224） |
| `$.session.surface` | 記載なし | 非推奨。`surfaces()` を使う（d.ts:2796） |
| `$.fs.list` の戻り値 | `{ name, kind, size, isLink }` | `mtimeMs` もある（d.ts:3235） |
| mods の既定有効バージョン | overview はターミナル v2.1.287 以降・Desktop v2.1.286 以降、admin は「v2.1.286 以降」 | 2 ページ間の小さな食い違い。ターミナルでは 2.1.287 を基準にするのが安全 |
| このリポジトリの `mods/types/` | — | 2.1.289 で生成されたもので、インストール済みの 2.1.292 より古い（`prompt.mention` と `prompt.autocomplete` がない） |

---

## 14. Claude Code の挙動を変更できる API 一覧とサンプルコード

3〜5 章の一覧から、Claude Code の動作、Claude（モデル）が読む内容、画面の表示のどれかを**変えられる**イベントと API だけを、「何を変えたいか」で引けるように並べ直したものです。観察しかできないイベント（`turn.start`、`session.measure` など）は除いています。

サンプルはすべて 2.1.292 の型定義に対して `tsc --strict` を通し、`claude plugin validate --strict` の静的解析も通過させています。ただし、実際のセッションで動かして挙動を確かめてはいません（[未確認事項](#未確認事項)）。

### 14.1 一覧

| 分類 | 変えたいこと | イベント / API | hook が返すもの | サンプル |
| :- | :- | :- | :- | :- |
| ツール | 危険なツール呼び出しを止める | `tool.call` | `{ deny }` | 14.3 (1) |
| ツール | ツールの引数を書き換える | `tool.call` | `next({ ...e, 引数 })` | 14.3 (2) |
| ツール | ツール結果に Claude 向けの注記を足す | `tool.call` | `{ ...result, context }` | 14.3 (3) |
| ツール | 失敗したツールを再試行する | `tool.call` | 2 回目の `next(e)` | 14.3 (4) |
| ツール | 実行前にユーザーに確認する | `tool.call` + `$.ui.ask` | `next(e)` か `{ deny }` | 14.3 (5) |
| ツール | 許可判定（allow / ask / deny）を変える | `tool.check` | `{ decision, reason }` | 14.3 (6) |
| ツール | ツールの説明文や遅延読み込みを変える | `tool.describe` | `{ description, isDeferred }` | 14.3 (7) |
| ツール | Claude が使えるツールを追加する | `$.tool.register` + `tool.call` | `{ result }` | 14.3 (8) |
| Claude が読むもの | プロンプトを書き換える・注記を足す・送信を止める | `prompt.submit` | `next({ ...e, text, context })`、`{ drop }` | 14.4 (1) |
| Claude が読むもの | システムプロンプトにセクションを足す | `prompt.compose` | `{ sections }` | 14.4 (2) |
| Claude が読むもの | システムプロンプトの既存セクションを書き換える・消す | `prompt.section` | `{ text }`、`{ text: null }` | 14.4 (3) |
| Claude が読むもの | 会話冒頭のコンテキスト（CLAUDE.md など）に足す | `prompt.context` | `{ blocks }` | 14.4 (4) |
| Claude が読むもの | Claude Code が足すリマインダーを書き換える・消す | `prompt.attachment` | `{ text }`、`{ text: null }` | 14.4 (5) |
| Claude が読むもの | @メンションで読むファイルを差し替える・拒否する | `prompt.mention` | `next({ ...e, path })`、`{ deny }` | 14.4 (6) |
| Claude が読むもの | skill の本文に追記する | `skill.prompt` | `{ text }` | 14.4 (7) |
| Claude が読むもの | コミットや PR の attribution 文を変える | `attribution.text` | `{ text }` | 14.4 (8) |
| 入力欄 | 薄い提案（prompt suggestion）を出さない | `prompt.suggest` | `{ isShown: false }` | 14.5 (1) |
| 入力欄 | 補完候補を追加する（ドキュメント未記載） | `prompt.autocomplete` | `{ suggestions }` | 14.5 (2) |
| モデル | リクエストごとにモデルや effort を変える | `turn.step` | `yield* next({ ...e, model, effort })` | 14.6 (1) |
| モデル | ターン終了時に回答の下へ 1 行出す | `turn.complete` | `{ ...result, text }` | 14.6 (2) |
| モデル | 長すぎるターンを中断する | `turn.start` + `$.turn.abort` | — | 14.6 (3) |
| モデル | ユーザーの `/model` 切り替えを確認・拒否する | `classic.PreModelSwitch` | `{ permissionDecision }` | 14.6 (4) |
| サブエージェント | サブエージェントのモデルを選ぶ・起動を拒否する | `agent.spawn` | `next({ ...e, model })`、`{ deny }` | 14.7 (1) |
| サブエージェント | サブエージェント型を Claude から隠す | `agent.offer` | `{ isOffered: false }` | 14.7 (2) |
| サブエージェント | サブエージェント型を追加する | `$.agent.register` | — | 14.7 (3) |
| コマンド | スラッシュコマンドを追加する | `$.command.register` + `command.run` | `{ text }` | 14.8 (1) |
| コマンド | 組み込みコマンドの引数を補う | `command.run` | `next({ ...e, args })` | 14.8 (2) |
| コマンド | コマンドを一覧から隠す | `command.describe` | `{ ...result, isHidden: true }` | 14.8 (3) |
| 設定 | `/config` の変更を拒否する・行を隠す | `config.set` / `config.describe` | `{ deny }`、`{ isHidden: true }` | 14.8 (4) |
| セッション | compaction の指示を足す・止める | `session.compact` | `next({ ...e, instructions })`、`{ skip }` | 14.9 (1) |
| セッション | 他セッションからのメッセージを Claude に渡さない | `session.receive` | `{ consumed }` | 14.9 (2) |
| セッション | 他セッションへの送信を止める | `session.send` | `{ isDelivered: false, reason }` | 14.9 (3) |
| セッション | 会話ログに保存する内容を書き換える | `session.append` | `next({ ...e, message })` | 14.9 (4) |
| UI | Claude Code 自身の行（スピナーなど）の表示を変える | `ui.render` | `next({ ...e, props })` | 14.10 (1) |
| UI | 質問ダイアログに自分の表示を足す | `ui.render`（`AskUserQuestion`） | 要素ツリー | 14.10 (2) |
| 他の mod | mod の読み込みを拒否する | `plugin.register` | `{ refuse }` | 14.11 (1) |
| 他の mod | 他の mod の API 呼び出しを拒否する | `fs.write` などの API 呼び出しイベント | `{ deny }` | 14.11 (2) |
| 他の mod | mod に渡す `$` に名前空間を足す・取り除く | `engine.create` | 名前空間を足した API | 3 章 |
| 設定フック | 設定フックと同じ判定を mod から返す | `classic.*` | `ClassicResult` のフィールド | 14.12 |
| 操作 | ターンを始める、compaction する、設定や環境変数を変えるなど | `$.prompt.submit`、`$.session.compact`、`$.env.set` ほか | — | 14.13 |

### 14.2 雛形

以降のサンプルは、`hooks/register.ts` の `register` 関数の**中身**だけを示します。そのまま次の雛形の `// ここにサンプル` に貼れば動く形にしてあります。

```typescript
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  // ここにサンプル
}
```

前提:

- プラグイン名は `example` とします（`.claude-plugin/plugin.json` の `name`）。`$.tool.register` で登録したツールは `mcp__example__<name>` になります。
- `$.tool.register`、`$.command.register`、`$.agent.register` はセッションに結び付く前は reject されるので、`session.start` の hook の中で呼びます。
- 同じイベントを matcher なしで 2 回 `on` すると読み込みが失敗します。複数のサンプルを 1 つの mod にまとめるときは、同じイベントの hook を 1 つにまとめてください。
- `$` は必ず `$.名前空間.メソッド(...)` の形で書きます（7 章の静的解析の制約）。

### 14.3 ツール実行

(1) 危険なコマンドを止める。`{ deny }` の文字列は、ツールのエラー結果として Claude が読みます。権限プロンプトは出ません。

```ts
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (/\brm\s+-\w*(rf|fr)/.test(e.command)) {
    return { deny: 'rm -rf is blocked in this repository. Remove the files by name.' }
  }
  return next(e)
})
```

(2) 引数を書き換える。auto モードでは、分類器の審査後に書き換えた呼び出しが拒否されることがあります（9 章）。

```ts
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (!/^git (log|diff|show)\b/.test(e.command)) return next(e)
  return next({ ...e, command: e.command.replace(/^git /, 'git --no-pager ') })
})
```

(3) ツール結果の後に、Claude だけが読む注記を足す。ユーザーには表示されません。

```ts
on('tool.call', { tool: 'Read' }, async ($, e, next) => {
  const result = await next(e)
  if (result.deny !== undefined || !e.file_path.includes('/generated/')) return result
  return {
    ...result,
    context: [
      ...(result.context ?? []),
      'This file is generated. Edit the schema under schema/ and run `pnpm gen` instead.',
    ],
  }
})
```

(4) 失敗したら 1 回だけ再試行する。`$.clock.sleep` の待ち時間は hook の制限時間（10 秒）に含まれます。

```ts
on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
  const first = await next(e)
  if (first.isError !== true) return first
  await $.clock.sleep(2000)
  return next(e)
})
```

(5) 実行前にユーザーに選ばせる。`$.ui.ask` はダイアログを閉じられたときと `-p` では reject するので、`.catch` で `{ deny }` を返して fail closed にします。

```ts
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (!/\bgit\s+push\b/.test(e.command)) return next(e)
  const answer = await $.ui.ask(`Run "${e.command}"?`, ['Push', 'Cancel'])
  return answer === 'Push' ? next(e) : { deny: 'The user cancelled the push.' }
}).catch(() => ({ deny: 'The push was not confirmed.' }))
```

(6) 許可判定を変える。`next(e)` が返すのはルール・権限モード・設定フックが出した判定です。この例は、シェルの区切り文字を含まない読み取り専用の git コマンドだけ `ask` を `allow` に変えます。組み込みガードが読み込まれる環境では、`deny` ルールで拒否された呼び出しは mod から承認できません（10 章）。

```ts
on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
  const verdict = await next(e)
  const { command } = e.input as { command: string }
  if (verdict.decision === 'ask' && /^git (status|diff|log)( [^;&|`$<>()]*)?$/.test(command)) {
    return { decision: 'allow', reason: 'read-only git command' }
  }
  return verdict
})
```

(7) ツールの説明文を変える、遅延読み込み（ToolSearch の後ろに回すか）を変える。説明文を毎回変えるとプロンプトキャッシュが効かなくなるので、固定の文字列にします。

```ts
on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
  const described = await next(e)
  return {
    ...described,
    description: `${described.description}\n\nIn this repository run tests with \`pnpm test\`, never \`npm test\`.`,
  }
})

on('tool.describe', { tool: /^mcp__github__/ }, async ($, e, next) => ({
  ...(await next(e)),
  isDeferred: false,
}))
```

(8) ツールを追加する。Claude からは `mcp__example__word_count` として見え、処理は `tool.call` の hook が `{ result }` を返して行います。どの hook も答えない呼び出しは失敗します。

```ts
on('session.start', async ($, e, next) => {
  await $.tool.register({
    name: 'word_count',
    description: 'Counts the words of a text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  })
  return next(e)
})

on('tool.call', { tool: 'mcp__example__word_count' }, async ($, e) => {
  const { text } = e as unknown as { text: string }
  return { result: { words: text.split(/\s+/).filter(Boolean).length } }
})
```

組み込みツールの呼び出しにも `{ result }` で答えられますが、そのツールに出力スキーマがあれば Claude Code が検証するので、ツールごとの結果の形（`claude-code-tools/index.d.ts`）に合わせる必要があります。

### 14.4 Claude が読むもの

(1) プロンプトの書き換え、注記の追加、送信の中止。`text` を変えると transcript にも反映されます。`context` はユーザーには表示されません。`{ drop }` の文字列は理由としてユーザーに表示されます。

```ts
on('prompt.submit', async ($, e, next) => {
  if (/\bAKIA[0-9A-Z]{16}\b/.test(e.text)) {
    return { drop: 'The prompt contains an AWS access key ID. Remove it and send again.' }
  }
  const text = e.text.replace(/^ja:\s*/, '')
  if (text === e.text) return next(e)
  return next({ ...e, text, context: [...(e.context ?? []), 'Answer this prompt in Japanese.'] })
})
```

(2) システムプロンプトにセクションを足す。`id` は `<plugin>:<名前>` の形にします。`scope: 'shared'` は全ユーザーで同じ文面のときだけ使い、リポジトリごとに変わる文面は `session` にします（`shared` のセクションは `session` より前に並べる必要があります）。

```ts
on('prompt.compose', async ($, e, next) => {
  const { sections } = await next(e)
  return {
    sections: [
      ...sections,
      { id: 'example:review', text: 'Keep each change small enough to review in one sitting.', scope: 'session' },
    ],
  }
})
```

(3) システムプロンプトの名前付きセクションを書き換える。セクション名（`env_info_simple`、`memory` など）は `prompt.compose` の `sections` の `id` で確かめられます。`{ text: null }` を返すとセクションが消えます。

```ts
on('prompt.section', { name: 'env_info_simple' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: text === null ? null : `${text}\nOutbound HTTP goes through the corporate proxy.` }
})
```

(4) 会話の最初のメッセージに付くコンテキスト（CLAUDE.md の内容など）にブロックを足す。会話ごとに 1 回だけ発火します。

```ts
on('prompt.context', async ($, e, next) => {
  const result = await next(e)
  const conventions = await $.fs.read('docs/CONVENTIONS.md').catch(() => undefined)
  if (conventions === undefined) return result
  return { ...result, blocks: [...result.blocks, { name: 'conventions', text: conventions }] }
})
```

(5) Claude Code が会話に足すメッセージ（リマインダーなど）を書き換える。`e.type` が種類です。型定義で中身（`e.detail`）が定義されている種類は `plan_mode`、`plan_mode_reentry`、`plan_mode_exit` の 3 つで、それ以外は `text` だけを持ちます。

```ts
on('prompt.attachment', { type: 'plan_mode' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: text === null ? null : `${text}\n\nWrite the plan in Japanese.` }
})
```

(6) @メンションされたファイルを差し替える、または添付を拒否する（v2.1.290 以降）。

```ts
on('prompt.mention', async ($, e, next) => {
  if (/\.(pem|key)$/.test(e.path)) return { deny: 'private keys are never attached' }
  if (/(^|\/)\.env$/.test(e.path)) return next({ ...e, path: `${e.path}.example` })
  return next(e)
})
```

(7) skill の本文に追記する。matcher の `skill` は skill 名です。

```ts
on('skill.prompt', { skill: 'commit' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: `${text}\n\nSign every commit with \`git commit --gpg-sign\`.` }
})
```

(8) コミットや PR に付く attribution 文を変える。`kind` は `commit`、`pr`、`exemption`、`remedy` のどれかです。

```ts
on('attribution.text', { kind: 'commit' }, async ($, e, next) => {
  const { text } = await next(e)
  return { text: `${text}\nReviewed-by: nobody yet` }
})
```

### 14.5 入力欄

(1) 入力欄に薄く出る提案を出さない。`next` を呼ばずに `{ isShown: false }` を返すと、Claude Code 自身の提案も含めて表示されません。

```ts
on('prompt.suggest', async () => ({ isShown: false }))
```

(2) 入力補完の候補を追加する。ドキュメントに載っていない 2.1.292 のイベントで（d.ts:4123, 8173）、カーソル位置のトークン（`e.token`）が候補で置き換わります。候補は Claude Code 自身の候補の下に並びます。

```ts
on('prompt.autocomplete', async ($, e, next) => {
  const result = await next(e)
  if (!e.token.startsWith(':')) return result
  const snippets = [
    { text: 'Looks good to me.', label: ':lgtm', description: 'approval' },
    { text: 'Please add a test that fails without this change.', label: ':test', description: 'ask for a test' },
  ].filter((s) => s.label.startsWith(e.token))
  return { suggestions: [...result.suggestions, ...snippets] }
})
```

### 14.6 モデルとターン

(1) モデルへの 1 リクエストごとにモデルや effort を変える。`turn.step` の hook は async generator で書き、`yield* next(e)` で応答のストリームを流します（普通の async 関数は型エラーになります）。サブエージェントのリクエストには `e.agentId` があります。

```ts
on('turn.step', async function* ($, e, next) {
  if (e.agentId !== undefined) {
    return yield* next({ ...e, model: 'claude-haiku-4-5-20251001' })
  }
  return yield* next({ ...e, effort: e.index === 0 ? 'high' : 'medium' })
})
```

(2) ターンの最後に、回答の下へ 1 行表示する。

```ts
on('turn.complete', async ($, e, next) => {
  const result = await next(e)
  if (e.usage === undefined) return result
  const seconds = Math.round(e.durationMs / 1000)
  return { ...result, text: `${e.usage.output_tokens} output tokens in ${seconds}s` }
})
```

(3) 10 分を超えたターンを中断する。タイマーは `$.clock` で作り（`setTimeout` はない）、ターンが終わったら止めます。

```ts
const timers = new Map<string, { cancel: () => void }>()

on('turn.start', async ($, e, next) => {
  const result = await next(e)
  const timer = $.clock.after(10 * 60_000, () => {
    $.turn.abort({ turnId: e.turnId })
  })
  timers.set(e.turnId, timer)
  return result
})

on('turn.complete', async ($, e, next) => {
  timers.get(e.turnId)?.cancel()
  timers.delete(e.turnId)
  return next(e)
})
```

(4) セッションのモデル切り替え（`/model`、`/config` の Model 行、モデルピッカー、SDK の `set_model`）に介入する。`e` には切り替え前後のモデル、プロンプトキャッシュが温まっているか、再キャッシュの推定費用（`estimated_cache_write_usd`）が入ります。この例は、温まったキャッシュを捨てる費用が 1 ドル以上のときに `'ask'` を返します（型は `ask` を受け付けますが、確認ダイアログが出るかは確かめていません）。`'deny'` を返せば切り替え自体を止められます。mod からセッション全体のモデルを直接変える API はなく（`$.session.model()` は読み取り専用）、`$.command.run({ command: 'model', args: 'opus' })` でユーザーが `/model opus` と打ったのと同じ操作をするのが型定義から読み取れる経路です（実行しては確かめていません）。自動フォールバックによる切り替え（`source: 'auto'`）は `PreModelSwitch` を発火しないので止められず、`classic.PostModelSwitch` で事後に知ることだけができます。

```ts
on('classic.PreModelSwitch', async ($, e, next) => {
  if (!e.prompt_cache_warm || e.estimated_cache_write_usd < 1) return next(e)
  return {
    permissionDecision: 'ask',
    permissionDecisionReason: `Switching to ${e.to_model} re-caches about $${e.estimated_cache_write_usd.toFixed(2)} of context.`,
  }
})
```

### 14.7 サブエージェント

(1) サブエージェントのモデルを選ぶ、または起動を拒否する。agent team の teammate の起動も同じイベントで、`e.isTeammate` が付きます。

```ts
on('agent.spawn', async ($, e, next) => {
  if (e.isTeammate === true) return { deny: 'Agent teams are turned off in this repository.' }
  if (e.subagentType === 'Explore') return next({ ...e, model: 'haiku' })
  return next(e)
})
```

(2) サブエージェント型を Claude に見せない。`$.agent.spawn` からは引き続き起動できます。

```ts
on('agent.offer', { agent: 'general-purpose' }, async () => ({ isOffered: false }))
```

(3) サブエージェント型を追加する。名前は `<plugin>:<name>`（ここでは `example:reviewer`）になり、指定できるフィールドは agent ファイルと同じです。

```ts
on('session.start', async ($, e, next) => {
  await $.agent.register({
    name: 'reviewer',
    description: 'Reviews the staged diff for correctness bugs. Use before committing.',
    prompt: 'You review `git diff --cached`. Report only defects that change behavior, with file and line.',
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'opus',
  })
  return next(e)
})
```

### 14.8 コマンドと設定

(1) スラッシュコマンドを追加する。`immediate: true` にすると、Claude の作業中でもターンを待たずに実行されます。`{ text }` は transcript に表示され、Claude も読みます。

```ts
on('session.start', async ($, e, next) => {
  await $.command.register({ name: 'branch', description: 'Shows the current git branch.', immediate: true })
  return next(e)
})

on('command.run', { command: 'branch' }, async ($) => {
  const run = await $.process.run(['git', 'branch', '--show-current'])
  return { text: run.exitCode === 0 ? run.stdout.trim() : run.stderr.trim() }
})
```

(2) 組み込みコマンドの引数を補う。この例は、引数なしの `/compact` に要約の指示を付けます。`-p` で 1 コマンドだけ実行したときの終了コードは `{ text, exitCode }` で返せます。

```ts
on('command.run', { command: 'compact' }, async ($, e, next) => {
  if (e.args.trim() !== '') return next(e)
  return next({ ...e, args: 'Keep every file path, command and decision verbatim.' })
})
```

(3) コマンドを一覧（typeahead）から隠す。隠しても名前を打てば実行できるので、実行を止めるには `command.run` で `{ text }` を返します。

```ts
on('command.describe', { command: ['upgrade', 'passes'] }, async ($, e, next) => ({
  ...(await next(e)),
  isHidden: true,
}))
```

(4) `/config` の変更を拒否する、行を隠す。キー名は `$.config.list()` の `key` で確かめられます。

```ts
on('config.set', { key: 'verbose' }, async ($, e, next) => {
  if (e.value === false) return { deny: 'verbose output stays on in this repository' }
  return next(e)
})

on('config.describe', { key: 'theme' }, async ($, e, next) => ({ ...(await next(e)), isHidden: true }))
```

### 14.9 セッション

(1) compaction に指示を足す。`{ skip: 理由 }` を返すと compaction 自体が止まり、`{ messages }` を返すと要約の代わりにそのメッセージ列が使われます（後者の実装例はこのリポジトリの `mods/decision-compaction`）。

```ts
on('session.compact', async ($, e, next) => {
  const rule = 'Keep every open task and every decision with its reason.'
  const instructions = e.instructions === undefined ? rule : `${e.instructions}\n${rule}`
  return next({ ...e, instructions })
})
```

(2) 他のエージェントやセッションから届いたメッセージを、Claude に渡さずに処理する。

```ts
on('session.receive', async ($, e, next) => {
  if (!/^\s*ping\s*$/i.test(e.text)) return next(e)
  $.ui.toast('ping received')
  return { consumed: 'ping is answered by the example mod' }
})
```

(3) 他のセッションへの送信を止める（SendMessage ツールからの送信も含む）。

```ts
on('session.send', async ($, e, next) => {
  if (/BEGIN [A-Z ]*PRIVATE KEY/.test(e.text)) {
    return { isDelivered: false, reason: 'the message contains a private key' }
  }
  return next(e)
})
```

(4) 会話ログに保存する内容を書き換える。プロンプト、応答、ツール結果などの各行が保存される前に発火します。この例はテキストブロック中の AWS アクセスキー ID を伏せ字にします。

```ts
on('session.append', async ($, e, next) => {
  const content = e.message.content.map((block) =>
    block.type === 'text' && typeof block.text === 'string'
      ? { ...block, text: block.text.replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA****') }
      : block,
  )
  return next({ ...e, message: { ...e.message, content } })
})
```

### 14.10 UI の差し替え

(1) Claude Code 自身の行の props を一部だけ変える。描ける場所と props は 5 章の表のとおりです。

```ts
on('ui.render', { component: 'Spinner' }, async ($, e, next) =>
  next({ ...e, props: { ...e.props, word: 'Brewing' } }),
)
```

(2) 質問ダイアログ（`AskUserQuestion`）の上に自分の表示を足す。`await next(e)` が返す Claude Code 自身のダイアログをちょうど 1 回含める必要があり、満たさない場合は Claude Code 自身のダイアログだけが描かれます。JSX を使うのでファイル名は `.tsx` にします。権限プロンプトは変更できません。

```tsx
on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      <Text color="yellow">Claude is waiting for your answer.</Text>
      {await next(e)}
    </Box>
  )
})
```

ターンを始めずに表示だけしたい場合は、`$.ui.status`（プロンプト下の 1 行）、`$.ui.toast`（右上のトースト）、`$.ui.log`（transcript の薄い行）を使います（4 章）。

### 14.11 他の mod とポリシー

ポリシー mod は、`prependPlugins` に入れてユーザーの mod より前（チェーンの外側）で動かします（10 章）。

(1) 条件に合う mod の読み込みを拒否する。hook が throw すると fail open になるので、`.catch` で `{ refuse }` を返して fail closed にします。

```ts
on('plugin.register', async ($, e, next) => {
  if (e.tier === 'user' && e.uses.calls.some((call) => call.startsWith('process.'))) {
    return { refuse: 'user mods may not start processes on this machine' }
  }
  return next(e)
}).catch(() => ({ refuse: 'the plugin policy could not be checked' }))
```

(2) 他の mod の API 呼び出しを拒否する。mods API のメソッドはそれぞれイベントでもあり、`next.origin` で呼び出し元の mod と tier がわかります。

```ts
on('fs.write', async ($, e, next) => {
  if (next.origin.tier === 'user' && /(^|\/)\.git\/hooks\//.test(e.path)) {
    return { deny: 'mods may not write git hooks' }
  }
  return next(e)
})
```

### 14.12 設定フックイベント（`classic.*`）

設定フック（`settings.json` の `hooks`）と同じ判定を mod から返せます。`e` は設定フックが stdin で受け取る JSON と同じで、返す値は `ClassicResult`（d.ts:1266）のフィールドです。設定フックの JSON 出力との対応は次のとおりです。

| `ClassicResult` のフィールド | 設定フックでの書き方 | 効くイベント |
| :- | :- | :- |
| `block` | `decision: "block"` と `reason`（コマンドフックの終了コード 2） | イベントごとのブロック・拒否・再プロンプト |
| `preventContinuation` / `stopReason` | `continue: false` / `stopReason` | そのイベントの後でセッションを止める |
| `additionalContext` | `hookSpecificOutput.additionalContext` | Claude に渡すテキスト |
| `sessionTitle` | `hookSpecificOutput.sessionTitle` | UserPromptSubmit、SessionStart |
| `suppressOriginalPrompt` | `hookSpecificOutput.suppressOriginalPrompt` | UserPromptSubmit、UserPromptExpansion |
| `initialUserMessage` / `watchPaths` / `reloadSkills` | `hookSpecificOutput` の同名フィールド | SessionStart |
| `permissionDecision` / `permissionDecisionReason` | `hookSpecificOutput` の同名フィールド | PreModelSwitch |
| `decision` | `hookSpecificOutput.decision`（`behavior: 'allow' / 'deny'`） | PermissionRequest |
| `updatedToolOutput` / `updatedMCPToolOutput` | `hookSpecificOutput` の同名フィールド | PostToolUse |
| `retry` | `hookSpecificOutput.retry` | PermissionDenied |
| `displayContent` | `hookSpecificOutput.displayContent` | MessageDisplay |
| `worktreePath` | `hookSpecificOutput.worktreePath` | WorktreeCreate |

`classic.PreToolUse` だけは `e` がツール呼び出しの envelope になるので、ツール呼び出しの変更には `tool.call` を使うほうが素直です。

次の例は、テストが通るまで Claude に作業を続けさせます。`Stop` の `block` は「止まらずに続ける」指示として Claude に渡ります。`stop_hook_active` が立っているときに再び `block` すると、終わらないループになるので素通しします。

```ts
on('classic.Stop', async ($, e, next) => {
  if (e.stop_hook_active) return next(e)
  const run = await $.process.run(['pnpm', 'test'], { timeoutMs: 5 * 60_000 })
  if (run.exitCode === 0) return next(e)
  return { block: `pnpm test failed. Fix it before stopping:\n${run.stdout.slice(-2000)}` }
})
```

### 14.13 API 呼び出しで Claude Code を動かす

hook の結果ではなく、`$` のメソッドを呼ぶことで Claude Code に何かをさせる API です。

| API | すること |
| :- | :- |
| `$.prompt.submit({ text, asUser? })` | アイドル時に新しいターンを始める。既定では mod 名を名乗る一文が前に付く |
| `$.prompt.fill({ text, mode })` / `$.prompt.suggest({ text })` | 入力欄の下書きを置き換え・追記・挿入する / 薄い提案を出す |
| `$.session.compact({ instructions? })` | compaction を実行する |
| `$.session.append({ message })` | 会話に行（`user` か `system`）を足す |
| `$.session.send({ to, text })` | 他のエージェントやセッションにメッセージを送る（SendMessage ツールと同じ配送） |
| `$.turn.abort({ turnId })` | 実行中のターンと実行中のツールを止める |
| `$.command.run({ command, args? })` | スラッシュコマンドをユーザーが打ったのと同じように実行する |
| `$.config.set({ key, value })` | `/config` の行を変える |
| `$.env.set(name, value)` | 環境変数を変える。以後 Claude Code が起動するコマンドと MCP サーバーにも効く |
| `$.agent.spawn({ prompt, subagentType? })` | サブエージェントをバックグラウンドで起動する |
| `$.tool.call({ tool, ...引数 })` | ツールを呼ぶ（他の mod の `tool.call` hook を通る） |

次の例は、`/handoff` で compaction してから引き継ぎメモを書かせ、以後のコマンドでページャーを使わないようにします。

```ts
on('session.start', async ($, e, next) => {
  await $.command.register({ name: 'handoff', description: 'Compacts, then asks Claude for a handoff note.' })
  await $.env.set('GIT_PAGER', 'cat')
  return next(e)
})

on('command.run', { command: 'handoff' }, async ($) => {
  await $.session.compact({ instructions: 'Keep open tasks and decisions.' })
  await $.prompt.submit({ text: 'Write a handoff note for the next session in HANDOFF.md.', asUser: true })
  return {}
})
```

## 未確認事項

- Desktop アプリでの描画（`Svg`、Desktop 版の hotkey 表示など）は実機で確かめていません。
- `prompt.autocomplete` は型定義を読んだだけで、実際のセッションでの挙動は試していません。
- 「名前のみ」としたメソッド（`$.agent.*`、`$.audio.*`、`$.session.authorize`、`$.model.classify` など）の細かな挙動は型定義のコメントに基づいており、実行して確かめてはいません。
- `cc-plugin-you-should-know` が自分の組織で使えるかどうかは、`/plugin` → Installed → Show disabled で確認する必要があります。
- 14 章のサンプル 40 件は、2026-10-07 に Claude Code 2.1.292 の型定義に対する `tsc --strict`（TypeScript 5.9.3）と `claude plugin validate --strict` を通しています。各サンプルを 1 つの mod として組み立てて確かめたもので、実際のセッションで動かしてはいません。特に、`command.run` の hook から `$.session.compact` と `$.prompt.submit` を続けて呼ぶ 14.13 の例と、`turn.step` で `effort` を変える 14.6 (1) の例は、実行時の挙動を確かめていません。
