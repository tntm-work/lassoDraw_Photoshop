# lassoDraw (Photoshop UXP プラグイン)

投げ縄ツールで選択範囲を作った瞬間に、その範囲を **塗りつぶして選択解除** します。
Ctrl を押しながら確定した場合は **範囲内を削除して選択解除** します。

## 動作

| 操作 | 動作 |
| --- | --- |
| 投げ縄でドラッグ → マウスを離す | 描画色で塗りつぶし → 選択解除 |
| 投げ縄でドラッグ → **Ctrl を押しながら**マウスを離す | 範囲内を削除 → 選択解除 |

「削除」は Photoshop の Edit > Clear 相当です。通常レイヤーでは透明になり、
ロックされた背景レイヤーでは背景色で塗られます。

> **Windows での注意**
> 投げ縄ツールでは *ドラッグ開始時* に Ctrl を押していると移動ツールに切り替わります。
> ドラッグを始めてから、マウスを離す直前に Ctrl を押してください。

## ExtendScript ブリッジ

UXP 単体ではできないことが 2 つあり、どちらも ExtendScript 経由で解決しています。

```
UXP (main.js)
  └ batchPlay { _obj: "AdobeScriptAutomation Scripts", javascript: { _kind:"local", _path: token } }
      └ ExtendScript (ld_*.jsx)
          └ 結果を ld_*.out.txt に "<本文>\n<書き出し時刻>" 形式で書き出し
UXP が同ファイルを読み取る
```

`.jsx` はプラグインのデータフォルダーへ実行時に生成し、セッショントークンで実行します。
書き出された値のタイムスタンプが 5 秒以上古い場合は「取得失敗」と判定します。
実装は [extendscript.js](extendscript.js) にまとまっています。

### 1. モディファイアキーの取得

`photoshop.core` にキーボード関連 API は無く、ScriptUI の `keyboardState` 相当も未実装です。
ExtendScript の `ScriptUI.environment.keyboardState` はグローバルなキー状態を返すため、
これを読んで Ctrl / Cmd の押下を判定します。

- ExtendScript エンジンの初回起動は遅いため、パネル読み込み後に一度空打ちして温めます。
- 取得に失敗した場合は削除ではなく塗りつぶしにフォールバックします（誤削除防止）。

### 2. 境界線の描画

batchPlay の `{_obj:"stroke"}`（パスの境界線を描く）は、`executeAsModal` のスコープ内から
呼ぶと `{_obj:"error", message:"", result:-128}`（= ユーザーがキャンセル）で拒否される
環境があります。ツール ID を `paintbrushTool` / `brushTool` / `pencilTool` と変えても同じ
結果になるため、コマンド自体がモーダルスコープで弾かれています。

ExtendScript の DOM API にはこの制約が無いので、そちらで実行します。

```javascript
doc.selection.makeWorkPath(1.0);
doc.selection.deselect();
workPath.strokePath(ToolType.BRUSH);  // 削除モードは ToolType.ERASER
workPath.remove();
```

ブリッジが使えない環境では batchPlay 版に自動フォールバックします。

### 判定方法は 3 通りから選べます

パネルの「削除モードの判定方法」で切り替えます。

1. **キー状態を直接取得**（既定） — 上記の ExtendScript 経由。Ctrl / Alt / Shift から選択可。
2. **選択の合成方法で判定** — Photoshop は選択範囲の合成方法をイベント名で通知します
   （修飾なし → `set` / Shift → `addTo` / Alt → `subtractFrom`）。
   これを修飾キー代わりに使う方式で、ExtendScript に依存しません。
   将来 Photoshop から ExtendScript が外れた場合のフォールバックにもなります。
3. **パネルで切り替え** — 修飾キーを使わず、パネル上で塗りつぶし / 削除を切り替えます。

## パネルの設定項目

- **lassoDraw を有効にする** — 監視の ON / OFF（パネルのフライアウトメニューからも切替可）
- **塗りつぶし** — 描画色 / 背景色、不透明度（1〜100%）
- **ブラシで境界線を描く** — 下記参照
- **削除モードの判定方法** — 上記 3 方式
- **投げ縄ツールのみ対象** — OFF にすると長方形・楕円選択、クイック選択、
  自動選択ツールでも動作します
- **1 ヒストリーにまとめる** — 塗りつぶし（削除）と選択解除を 1 回の Undo で戻せるようにします

設定はプラグインのデータフォルダー内 `settings.json` に自動保存されます。

## ブラシで境界線を描く

チェックすると、塗りつぶし（削除）に加えて選択範囲の輪郭を **現在のブラシ** でなぞります。
ブラシツールに設定されているサイズ・硬さ・ブラシ先端・散布などがそのまま反映されます。

処理の順番は次の通りです。

1. 塗りつぶし（または削除）
2. 選択範囲 → 作業用パスに変換（許容値 1.0px）
3. **選択範囲を解除**
4. パスの境界線を描く（塗りつぶしモード = ブラシツール / 削除モード = 消しゴムツール）
5. 作業用パスを破棄

手順 3 を先に行うのは、選択範囲が残ったままだとブラシがそれでクリップされ、
線の内側半分しか描かれないためです。

手順 2〜5 は ExtendScript 側で実行します（理由は上記「境界線の描画」参照）。
また、これらは `suspendHistory` の外で実行するため、「1 ヒストリーにまとめる」を
ONにしていても塗りつぶしと境界線は別のヒストリー項目になります。

既存の作業用パスがある場合は置き換えられます（名前付きパスには影響しません）。

## インストール

### 開発用（UXP Developer Tool）

1. [UXP Developer Tool](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/) を起動
2. `Add Plugin...` からこのフォルダーの `manifest.json` を選択
3. Photoshop を起動した状態で `Load` をクリック
4. Photoshop の **プラグイン > lassoDraw** からパネルを表示

### 配布用（.ccx）

UXP Developer Tool の `Package` から `.ccx` を生成し、ダブルクリックでインストールします。

未署名の `.ccx` は環境によってインストールが拒否されることがあります。その場合は
上記の UXP Developer Tool 経由での読み込みを案内してください。
Adobe Marketplace / Exchange で公開する場合は、Adobe Developer Console で発行された
プラグイン id に差し替える必要があります（`manifest.json` の `id`）。

## 動作要件

- Photoshop 24.0 以降（UXP manifestVersion 5）
- Ctrl 検出には ExtendScript が有効であること（Photoshop 2026 時点では有効）

## ファイル構成

```
manifest.json    プラグイン定義
index.html       パネル UI
styles.css       パネルのスタイル
main.js          イベント監視と batchPlay 処理
extendscript.js  ExtendScript ブリッジ（キー状態取得 / 境界線描画）
```

## 実装メモ

- `action.addNotificationListener(["set", "addTo", "subtractFrom"], ...)` で
  選択範囲チャンネルへの変更を監視します。
- `to` が `{_enum: "ordinal"}` の通知（選択解除・すべてを選択）は無視します。
  これによりプラグイン自身が発行する選択解除でループしません。加えて `processing`
  フラグで多重実行を抑止しています。
- Alt（`subtractFrom`）を削除トリガーにした場合、Photoshop 側の処理結果は
  「既存範囲から引いた選択範囲」になるため、通知ディスクリプタに含まれる
  形状データ（`to`）から選択範囲を作り直してから削除します。
- 実際の描画は `core.executeAsModal()` 内の `batchPlay` で実行します。
  Photoshop が別のモーダル状態だった場合は 120ms 後に 1 度だけ再試行します。
- `AdobeScriptAutomation Scripts` のディスクリプタキーは環境によって
  `javascript` / `javaScript` の揺れがあるため、実際に結果が読めた方を採用します。
- 「パスの境界線を描く」の `using` に渡すツール ID は `brushTool` ではなく
  **`paintbrushTool`**（charID の `PbTl`）。`brushTool` を渡すとメッセージの無い
  エラーディスクリプタが返ります。バージョン差に備えて
  `paintbrushTool` → `brushTool` → `pencilTool` の順に試し、通った ID を記憶します。
- 作業用パスの削除は `{_ref:"path", _enum:"ordinal", _value:"targetEnum"}`（現在のパス）を
  使います。`{_ref:"path", _property:"workPath"}` はパスを *選択* するための参照であり、
  `delete` に渡すと Photoshop が「要求された操作を完了できません。プログラムエラーです。」
  を出します。
- batchPlay は失敗を reject ではなく結果オブジェクト（`_obj: "error"`）で返す場合があるため、
  `play()` ヘルパーで戻り値も検査し、どのステップで落ちたかをステータス欄に表示します。
  詳細は UXP Developer Tool のコンソールにも出力されます。
