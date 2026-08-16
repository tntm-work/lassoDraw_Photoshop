/*
 * extendscript.js
 *
 * UXP から ExtendScript (.jsx) を実行するための汎用ブリッジ。
 *
 *   UXP -> batchPlay("AdobeScriptAutomation Scripts") -> ExtendScript
 *       -> テキストファイルに結果を書き出し -> UXP が読み取り
 *
 * .jsx はプラグインのデータフォルダーへ実行時に生成し、セッショントークンで実行する。
 * 出力は "<本文>\n<書き出し時刻(ms)>" 形式。時刻を見て古い内容を掴まないようにする。
 *
 * 用途:
 *  - readModifiers()        ... ScriptUI.environment.keyboardState でキー状態を取得
 *                               （UXP にはグローバルなキー状態取得 API が無い）
 *  - strokeSelectionBorder()... 選択範囲を作業用パスにして現在のブラシで境界線を描く
 *                               （batchPlay の stroke は modal scope 内だと -128 で拒否される）
 */

const { action } = require("photoshop");
const { storage } = require("uxp");

/** 書き出された結果がこの時間より古ければ無効とみなす (ms) */
const STALE_MS = 5000;

/** batchPlay のキー名は環境により "javascript" / "javaScript" のどちらか */
const DESCRIPTOR_KEYS = ["javascript", "javaScript"];

const NO_DIALOG = { dialogOptions: "dontDisplay" };

let dataFolder = null;
let descriptorKey = null;
let available = null; // null=未判定, true/false=判定済み
let lastError = null;

/** id -> { token, source, outName } */
const scripts = new Map();

async function ensureFolder() {
  if (!dataFolder) {
    dataFolder = await storage.localFileSystem.getDataFolder();
  }
  return dataFolder;
}

function messageOf(e) {
  if (!e) return "不明なエラー";
  if (typeof e === "string") return e;
  return e.message || e.description || String(e);
}

function runCommand(key, token) {
  return action.batchPlay(
    [
      {
        _obj: "AdobeScriptAutomation Scripts",
        [key]: { _kind: "local", _path: token },
        _options: NO_DIALOG,
      },
    ],
    {}
  );
}

function parseOutput(text) {
  const raw = String(text);
  const index = raw.lastIndexOf("\n");
  if (index < 0) return null;
  const stamp = Number(raw.slice(index + 1).trim());
  if (!Number.isFinite(stamp)) return null;
  if (Math.abs(Date.now() - stamp) > STALE_MS) return null; // 古い / 書き込み失敗
  return raw.slice(0, index);
}

/**
 * jsx を用意して実行し、書き出された本文を返す。
 * 実行できなかった場合は null。
 *
 * @param {string} id            スクリプトの識別子（ファイル名に使う）
 * @param {function} buildSource (出力パスの文字列リテラル) => jsx ソース
 */
async function runScript(id, buildSource) {
  await ensureFolder();
  const outName = "ld_" + id + ".out.txt";
  const outPath = (dataFolder.nativePath + "/" + outName).replace(/\\/g, "/");
  const source = buildSource(JSON.stringify(outPath));

  let entry = scripts.get(id);
  if (!entry || entry.source !== source) {
    const file = await dataFolder.createFile("ld_" + id + ".jsx", {
      overwrite: true,
    });
    await file.write(source);
    entry = {
      token: await storage.localFileSystem.createSessionToken(file),
      source: source,
      outName: outName,
    };
    scripts.set(id, entry);
  }

  const candidates = descriptorKey ? [descriptorKey] : DESCRIPTOR_KEYS;
  for (let i = 0; i < candidates.length; i++) {
    const key = candidates[i];
    try {
      await runCommand(key, entry.token);
    } catch (e) {
      lastError = messageOf(e);
      continue;
    }
    let payload = null;
    try {
      const out = await dataFolder.getEntry(entry.outName);
      payload = parseOutput(await out.read());
    } catch (e) {
      lastError = messageOf(e);
    }
    if (payload !== null) {
      descriptorKey = key;
      available = true;
      lastError = null;
      return payload;
    }
  }
  // 固定していたキー名で失敗した場合は、次回もう一度両方試せるようにする
  descriptorKey = null;
  available = false;
  if (!lastError) lastError = "ExtendScript が結果を書き出しませんでした";
  return null;
}

// ---------------------------------------------------------------------------
// モディファイアキーの取得
// ---------------------------------------------------------------------------

function keyStateSource(outLiteral) {
  return [
    "(function () {",
    // キー状態は最初に読む。処理が進むとユーザーがキーを離してしまうため。
    "    var st = ScriptUI.environment.keyboardState;",
    "    var line = (st.ctrlKey ? 1 : 0) + ',' + (st.shiftKey ? 1 : 0) + ',' +",
    "               (st.altKey ? 1 : 0) + ',' + (st.metaKey ? 1 : 0);",
    "    var f = new File(" + outLiteral + ");",
    "    f.encoding = 'UTF-8';",
    "    f.open('w');",
    "    f.write(line + '\\n' + (new Date()).getTime());",
    "    f.close();",
    "})();",
    "",
  ].join("\n");
}

/**
 * 現在のモディファイアキー状態を取得する。
 * 必ず executeAsModal のコールバック内から呼ぶこと。取得できなければ null。
 */
async function readModifiers() {
  let payload;
  try {
    payload = await runScript("keystate", keyStateSource);
  } catch (e) {
    available = false;
    lastError = messageOf(e);
    return null;
  }
  if (payload === null) return null;
  const parts = payload.trim().split(",");
  if (parts.length < 4) {
    lastError = "キー状態の解析に失敗しました";
    return null;
  }
  return {
    ctrlKey: parts[0] === "1",
    shiftKey: parts[1] === "1",
    altKey: parts[2] === "1",
    metaKey: parts[3] === "1",
  };
}

// ---------------------------------------------------------------------------
// 境界線の描画
// ---------------------------------------------------------------------------

/**
 * 選択範囲 -> 作業用パス -> 選択解除 -> 現在のブラシで境界線 -> 作業用パス破棄。
 *
 * 選択範囲を先に解除するのは、選択範囲が残っているとブラシがそれでクリップされ
 * 線の内側半分しか描かれないため。
 */
function strokeSource(toolType, tolerance) {
  return function (outLiteral) {
    return [
      "(function () {",
      "    var msg = 'ok';",
      "    try {",
      "        var doc = app.activeDocument;",
      "        doc.selection.makeWorkPath(" + tolerance + ");",
      "        try { doc.selection.deselect(); } catch (de) {}",
      "        var wp = null;",
      "        for (var i = 0; i < doc.pathItems.length; i++) {",
      "            if (doc.pathItems[i].kind == PathKind.WORKPATH) {",
      "                wp = doc.pathItems[i];",
      "                break;",
      "            }",
      "        }",
      "        if (wp === null) { throw new Error('work path not found'); }",
      "        wp.strokePath(ToolType." + toolType + ");",
      "        wp.remove();",
      "    } catch (e) {",
      "        msg = 'error: ' + e.toString();",
      "    }",
      "    var f = new File(" + outLiteral + ");",
      "    f.encoding = 'UTF-8';",
      "    f.open('w');",
      "    f.write(msg + '\\n' + (new Date()).getTime());",
      "    f.close();",
      "})();",
      "",
    ].join("\n");
  };
}

/**
 * 境界線を描く。
 * 戻り値: "ok" | "error: ..." | null(ブリッジ自体が使えない)
 * "ok" のときは選択解除まで済んでいる。
 */
async function strokeSelectionBorder(toolType, tolerance) {
  try {
    return await runScript(
      "stroke_" + toolType.toLowerCase(),
      strokeSource(toolType, tolerance)
    );
  } catch (e) {
    available = false;
    lastError = messageOf(e);
    return null;
  }
}

// ---------------------------------------------------------------------------

function isAvailable() {
  return available;
}

function getLastError() {
  return lastError;
}

module.exports = {
  readModifiers,
  strokeSelectionBorder,
  isAvailable,
  getLastError,
};
