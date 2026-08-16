/*
 * lassoDraw - Photoshop UXP plugin
 *
 * 選択範囲が確定した瞬間に、その範囲を塗りつぶす（または削除する）→ 選択解除。
 *
 * 修飾キーの判定方法は 3 通り用意している。
 *
 *  1. keyboard (既定)
 *     ExtendScript の ScriptUI.environment.keyboardState を batchPlay 経由で呼び、
 *     確定時の Ctrl / Cmd 押下状態を取得する。詳細は extendscript.js を参照。
 *
 *  2. event
 *     Photoshop は選択範囲の合成方法をイベント名で通知する。
 *       修飾なし -> "set" / Shift -> "addTo" / Alt -> "subtractFrom"
 *     これを修飾キー代わりに使う。ExtendScript に依存しないフォールバック。
 *
 *  3. panel
 *     修飾キーを使わず、パネル上のラジオボタンでモードを切り替える。
 */

const { app, action, core } = require("photoshop");
const { entrypoints, storage } = require("uxp");
const es = require("./extendscript");

const SETTINGS_FILE = "settings.json";

const LASSO_TOOLS = ["lassoTool", "polySelTool", "magneticLassoTool"];
const OTHER_SELECTION_TOOLS = [
  "marqueeRectTool",
  "marqueeEllipTool",
  "singleRowMarqueeTool",
  "singleColumnMarqueeTool",
  "quickSelectTool",
  "magicWandTool",
  "objectSelectionTool",
];

/** 監視する選択範囲系イベント */
const WATCHED_EVENTS = ["set", "addTo", "subtractFrom"];

/**
 * ショートカット用。UXP には独自のグローバルショートカットを登録する API が無いため、
 * Photoshop 側の「スクリプトにキーボードショートカットを割り当てる」仕組みを間借りする。
 * scripts/lassoDraw Toggle.jsx を Photoshop の Presets/Scripts に置き、
 * そのスクリプトが実行されたことをアクションイベントとして検知して ON/OFF を切り替える。
 */
const SCRIPT_EVENT = "AdobeScriptAutomation Scripts";
const TOGGLE_SCRIPT_KEYWORD = "lassodraw";

const settings = {
  enabled: true,
  opacity: 100,
  strokeBorder: false, // 現在のブラシで境界線を描く
  selectionOnly: false, // 塗りつぶさずに選択範囲だけ残す（削除モードには影響しない）
  modifierSource: "keyboard", // "keyboard" | "event" | "panel"
  deleteKey: "ctrlKey", // modifierSource === "keyboard" のとき
  deleteTrigger: "addTo", // modifierSource === "event" のとき ("addTo" | "subtractFrom")
  panelMode: "fill", // modifierSource === "panel" のとき ("fill" | "delete")
  lassoOnly: true,
  oneUndo: true,
};

/** 自分が発行したコマンドによる通知を無視するためのフラグ */
let processing = false;

// ---------------------------------------------------------------------------
// 設定の保存 / 読み込み
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const entry = await folder.getEntry(SETTINGS_FILE);
    const saved = JSON.parse(await entry.read());
    Object.keys(settings).forEach((key) => {
      if (saved[key] !== undefined) settings[key] = saved[key];
    });
  } catch (e) {
    // 初回起動時はファイルが無い。既定値のままで良い。
  }
}

async function saveSettings() {
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const file = await folder.createFile(SETTINGS_FILE, { overwrite: true });
    await file.write(JSON.stringify(settings, null, 2));
  } catch (e) {
    // 保存に失敗しても動作自体は継続させる
  }
}

// ---------------------------------------------------------------------------
// batchPlay ディスクリプタ
// ---------------------------------------------------------------------------

/**
 * "dontDisplay" は「エラー時や追加パラメータが必要な場合は UI を表示することがある」
 * という仕様で、実際に塗りつぶしのオプションダイアログが出てしまう。
 * "silent" なら UI を出さずスクリプトエラーとして返ってくる。
 */
const NO_DIALOG = { dialogOptions: "silent" };

/**
 * 透明ピクセルをロックしたレイヤーでは Photoshop が「透明部分の保持」を強制する。
 * preserveTransparency を渡さないと「パラメータが足りない」と判断され、
 * 塗りつぶしダイアログが表示されてしまうので明示的に指定する。
 */
function fillCommand(preserveTransparency) {
  return {
    _obj: "fill",
    using: { _enum: "fillContents", _value: "foregroundColor" },
    opacity: { _unit: "percentUnit", _value: settings.opacity },
    mode: { _enum: "blendMode", _value: "normal" },
    preserveTransparency: !!preserveTransparency,
    _options: NO_DIALOG,
  };
}

function deleteCommand() {
  return { _obj: "delete", _options: NO_DIALOG };
}

function deselectCommand() {
  return {
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _enum: "ordinal", _value: "none" },
    _options: NO_DIALOG,
  };
}

/** 選択範囲から作業用パスを作るときの許容値 (px) */
const WORK_PATH_TOLERANCE = 1.0;

/**
 * 境界線を描く。実処理は ExtendScript 側 (extendscript.js) にある。
 *
 * batchPlay の {_obj:"stroke"} は executeAsModal のスコープ内から呼ぶと
 * {_obj:"error", message:"", result:-128}（ユーザーがキャンセル）で拒否されるため、
 * batchPlay では実装できない。
 *
 * measureOnly が true なら実際には描かず、
 * 「元の選択範囲 ∪ ブラシが塗るはずの範囲」を選択状態にして返す。
 * 戻り値の deselected が true なら選択解除まで済んでいる。
 */
async function drawBorder(mode, measureOnly) {
  const toolType = mode === "fill" ? "BRUSH" : "ERASER";
  const keep = !!measureOnly;

  const result = await es.strokeSelectionBorder(
    toolType,
    WORK_PATH_TOLERANCE,
    keep
  );
  if (result === "ok") return { deselected: !keep };

  const detail =
    result === null
      ? "ExtendScript が使えません（" + (es.getLastError() || "原因不明") + "）"
      : result;
  const err = new Error("境界線の描画 / " + detail);
  err.step = "境界線の描画";
  console.error("[lassoDraw] 境界線の描画", detail);
  throw err;
}

/**
 * Alt (subtractFrom) を削除トリガーにした場合、Photoshop 側では
 * 「既存選択範囲から引く」処理になり、描いた形が選択範囲として残らない。
 * 通知ディスクリプタに含まれる形状データから選択範囲を作り直す。
 */
function replaySelectionCommand(descriptor) {
  const cmd = {
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: descriptor.to,
    _options: NO_DIALOG,
  };
  if (descriptor.antiAlias !== undefined) cmd.antiAlias = descriptor.antiAlias;
  if (descriptor.feather !== undefined) cmd.feather = descriptor.feather;
  return cmd;
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** 通知が「選択範囲チャンネル」に対するものか */
function isSelectionTarget(descriptor) {
  const target = descriptor && descriptor._target;
  if (!Array.isArray(target)) return false;
  return target.some((ref) => {
    if (!ref || ref._ref !== "channel") return false;
    const prop = ref._property;
    if (prop === "selection") return true;
    return !!prop && prop._value === "selection";
  });
}

/** 現在のツール ID を取得 */
async function getCurrentToolId() {
  try {
    if (app.currentTool && app.currentTool.id) return app.currentTool.id;
  } catch (e) {
    // DOM API が使えないバージョンでは batchPlay にフォールバック
  }
  try {
    const result = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "tool" },
            { _ref: "application", _enum: "ordinal", _value: "targetEnum" },
          ],
          _options: NO_DIALOG,
        },
      ],
      { synchronousExecution: false }
    );
    const tool = result && result[0] && result[0].tool;
    return tool ? tool._obj || tool._value : null;
  } catch (e) {
    return null;
  }
}

/**
 * アクティブレイヤーのロック状態を取得する。
 * 取得できなければ null（その場合はチェックせずに通す）。
 */
async function getLayerLocking() {
  try {
    const result = await action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _property: "layerLocking" },
            { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
          ],
          _options: NO_DIALOG,
        },
      ],
      { synchronousExecution: false }
    );
    return (result && result[0] && result[0].layerLocking) || null;
  } catch (e) {
    return null;
  }
}

/**
 * ロック状態から、この操作が Photoshop に拒否されるかを判定する。
 * 拒否される場合は理由の文字列、問題なければ null を返す。
 *
 * 事前に弾かないと Photoshop がモーダルのエラーダイアログを出してしまい、
 * 投げ縄のたびに操作が止まる。
 */
function lockBlockReason(locking, mode) {
  if (!locking) return null;
  if (locking.protectAll) return "レイヤーがロックされています";
  // 画像ピクセルのロック中は塗りつぶしも削除も描画もできない
  if (locking.protectComposite) return "画像ピクセルがロックされています";
  // 透明ピクセルのロック中は透明にできない = 削除が通らない
  if (mode === "delete" && locking.protectTransparency) {
    return "透明ピクセルがロックされているため削除できません";
  }
  return null;
}

function isAllowedTool(toolId) {
  if (!toolId) return true; // 判定できない場合は通す
  if (LASSO_TOOLS.indexOf(toolId) >= 0) return true;
  if (settings.lassoOnly) return false;
  return OTHER_SELECTION_TOOLS.indexOf(toolId) >= 0;
}

/**
 * 実行結果はパネルには出さず、UXP Developer Tool のコンソールにだけ流す。
 * 描画のたびにパネルの表示が変わると邪魔になるため。
 */
function setStatus(text, isError) {
  if (isError) console.error("[lassoDraw]", text);
  else console.log("[lassoDraw]", text);
}

function errorMessage(e) {
  if (!e) return "不明なエラー";
  if (typeof e === "string") return e;
  return e.message || e.description || String(e);
}

/**
 * batchPlay を 1 コマンドずつ実行する。
 * batchPlay は失敗を reject ではなく結果オブジェクトで返してくることがあるため、
 * 戻り値も確認したうえで「どのステップで落ちたか」を付けて投げ直す。
 */
async function play(step, descriptor) {
  let result;
  try {
    result = await action.batchPlay([descriptor], {});
  } catch (e) {
    const err = new Error(step + " / " + errorMessage(e));
    err.step = step;
    console.error("[lassoDraw]", step, e, descriptor);
    throw err;
  }
  const first = result && result[0];
  if (first && typeof first === "object" && first._obj === "error") {
    let detail = first.message;
    if (!detail) {
      try {
        detail = JSON.stringify(first).slice(0, 200);
      } catch (jsonError) {
        detail = "不明なエラー";
      }
    }
    const err = new Error(step + " / " + detail);
    err.step = step;
    console.error("[lassoDraw]", step, first, descriptor);
    throw err;
  }
  return result;
}

/** キー状態オブジェクトから、削除トリガーが押されているか判定する */
function isDeleteKeyDown(keys) {
  if (!keys) return false;
  switch (settings.deleteKey) {
    case "altKey":
      return !!keys.altKey;
    case "shiftKey":
      return !!keys.shiftKey;
    case "ctrlKey":
    default:
      // Windows の Ctrl と macOS の Command を同一視する
      return !!keys.ctrlKey || !!keys.metaKey;
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * イベント名から、処理対象かどうか・どのモードで動くかの下ごしらえをする。
 * 対象外なら null。
 * keyboard モードのときは mode を後から決めるので "pending" を返す。
 */
function resolvePlan(eventName) {
  if (settings.modifierSource === "panel") {
    if (eventName !== "set") return null;
    return { mode: settings.panelMode, needReplay: false };
  }
  if (settings.modifierSource === "keyboard") {
    // Ctrl / Cmd はイベント名を変えないので新規選択のみを見れば良い
    if (eventName !== "set") return null;
    return { mode: "pending", needReplay: false };
  }
  // event モード
  if (eventName === "set") return { mode: "fill", needReplay: false };
  if (eventName === settings.deleteTrigger) {
    return { mode: "delete", needReplay: eventName === "subtractFrom" };
  }
  return null;
}

async function onSelectionEvent(eventName, descriptor) {
  if (!settings.enabled || processing) return;
  if (!isSelectionTarget(descriptor)) return;

  // "to" が ordinal (none / allEnclosed) のものは選択解除・すべてを選択なので対象外。
  // 自分が発行する選択解除コマンドの通知もここで弾かれる。
  const to = descriptor.to;
  if (!to || to._enum === "ordinal") return;

  const plan = resolvePlan(eventName);
  if (!plan) return;

  processing = true;
  try {
    if (!app.documents || app.documents.length === 0) return;

    const toolId = await getCurrentToolId();
    if (!isAllowedTool(toolId)) return;

    await runOnSelection(plan, plan.needReplay ? descriptor : null);
  } catch (e) {
    setStatus("エラー: " + errorMessage(e), true);
  } finally {
    // 自分が発行したコマンドの通知が届き切るまで少し待ってから解除する
    setTimeout(() => {
      processing = false;
    }, 60);
  }
}

/** ディスクリプタから文字列を取り出す（`"名前"` と `{_value:"名前"}` の両方に対応） */
function stringValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value._value === "string") return value._value;
  return null;
}

/**
 * スクリプト実行イベントを監視して、ショートカット用スクリプトなら ON/OFF を切り替える。
 * プラグイン自身が実行する .jsx（キー状態取得・境界線描画）は
 * javaScriptName ではなくファイルパスで指定するので、ここでは弾かれる。
 */
function onScriptEvent(eventName, descriptor) {
  if (!descriptor) return;
  // 自分が発行したファイル指定の実行は対象外
  if (descriptor.javascript || descriptor.javaScript) return;
  const name =
    stringValue(descriptor.javaScriptName) ||
    stringValue(descriptor.javascriptName);
  if (!name) return;
  if (name.toLowerCase().indexOf(TOGGLE_SCRIPT_KEYWORD) < 0) return;

  settings.enabled = !settings.enabled;
  applySettingsToUI();
  saveSettings();
}

async function runOnSelection(plan, replayDescriptor) {
  let mode = plan.mode;
  let commandError = null;
  let strokeError = null;
  let keysMissing = false;
  let skipped = false;
  let blockedReason = null;
  let locking = null;

  const body = async (context) => {
    if (mode === "pending") {
      // 確定直後のキー状態を最優先で取りに行く（遅れるとキーが離される）
      const keys = await es.readModifiers();
      if (!keys) {
        keysMissing = true;
        mode = "fill";
      } else {
        mode = isDeleteKeyDown(keys) ? "delete" : "fill";
      }
    }

    // ロックされたレイヤーはコマンドが Photoshop に拒否され、
    // モーダルのエラーダイアログが出てしまうので事前に弾く。
    // ただし「選択範囲だけ残す」は元のレイヤーを触らないので対象外。
    if (!(mode === "fill" && settings.selectionOnly)) {
      locking = await getLayerLocking();
      blockedReason = lockBlockReason(locking, mode);
      if (blockedReason) return;
    }

    // 「塗りつぶさずに選択範囲だけ残す」: 一切描かず、選択解除もしない。
    // 境界線が ON のときは、ブラシが塗るはずの範囲を実測して
    // 元の選択範囲と合成したものを選択状態にする（描画はしない）。
    // 削除（修飾キー）は従来どおり動かす。
    if (mode === "fill" && settings.selectionOnly) {
      skipped = true;
      if (settings.strokeBorder) {
        try {
          await drawBorder(mode, true);
        } catch (e) {
          strokeError = e;
        }
      }
      return;
    }

    const label = mode === "fill" ? "lassoDraw: 塗りつぶし" : "lassoDraw: 削除";
    let historyId = null;
    if (settings.oneUndo) {
      try {
        historyId = await context.hostControl.suspendHistory({
          documentID: app.activeDocument.id,
          name: label,
        });
      } catch (e) {
        historyId = null;
      }
    }

    try {
      if (replayDescriptor) {
        await play("選択範囲の再作成", replaySelectionCommand(replayDescriptor));
      }
      try {
        await play(
          mode === "fill" ? "塗りつぶし" : "削除",
          mode === "fill"
            ? fillCommand(locking && locking.protectTransparency)
            : deleteCommand()
        );
      } catch (e) {
        // 空の選択範囲・ロックされたレイヤーなど。選択解除だけは行う。
        commandError = e;
      }
    } finally {
      // 境界線の描画はヒストリー抑制の外で行う。ブラシ系の操作が
      // suspendHistory 中だと失敗する環境があるため。
      if (historyId !== null) {
        try {
          await context.hostControl.resumeHistory(historyId);
        } catch (e) {
          // ignore
        }
      }
    }

    // 境界線は「選択範囲 -> 作業用パス」に変換して描く。
    // 選択範囲が残っているとブラシが選択範囲でクリップされ、線の内側半分しか
    // 描かれないため、パスを作ってから選択解除し、その後で描画する。
    let deselected = false;
    if (settings.strokeBorder) {
      try {
        // 削除モードでは消しゴムで境界線をなぞり、内側と挙動を揃える
        const result = await drawBorder(mode, false);
        deselected = !!result.deselected;
      } catch (e) {
        strokeError = e;
      }
    }

    if (!deselected) {
      try {
        await play("選択解除", deselectCommand());
      } catch (e) {
        if (!commandError) commandError = e;
      }
    }
  };

  await executeAsModalWithRetry(body, "lassoDraw");

  if (blockedReason) {
    setStatus("スキップ: " + blockedReason);
  } else if (skipped && strokeError) {
    setStatus("失敗: " + errorMessage(strokeError), true);
  } else if (skipped) {
    setStatus(
      settings.strokeBorder
        ? "選択範囲（元 + ブラシ範囲）を残しました"
        : "選択範囲を残しました"
    );
  } else if (commandError) {
    setStatus("失敗: " + errorMessage(commandError), true);
  } else if (strokeError) {
    setStatus("失敗: " + errorMessage(strokeError), true);
  } else if (keysMissing) {
    setStatus("塗りつぶし（キー状態を取得できず塗りつぶしにフォールバック）", true);
  } else {
    const what = mode === "fill" ? "塗りつぶし" : "削除";
    setStatus(what + (settings.strokeBorder ? " + 境界線" : "") + " を実行しました");
  }
}

/** Photoshop が別のモーダル状態のときは一度だけリトライする */
async function executeAsModalWithRetry(body, commandName) {
  try {
    await core.executeAsModal(body, { commandName });
  } catch (e) {
    if (e && (e.number === 9 || /modal/i.test(errorMessage(e)))) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await core.executeAsModal(body, { commandName });
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// ExtendScript ブリッジの事前確認 / ウォームアップ
// ---------------------------------------------------------------------------

/**
 * 初回呼び出しは ExtendScript エンジンの起動分だけ遅い。
 * 起動時に一度空打ちして温めておくと、実操作での取りこぼしが減る。
 */
async function warmUpKeyState() {
  try {
    await core.executeAsModal(
      async () => {
        await es.readModifiers();
      },
      { commandName: "lassoDraw: 初期化" }
    );
  } catch (e) {
    // ここでの失敗は致命的ではない。状態表示にだけ反映する。
  }
  updateKeyStateNotice();
}

/** キー状態が取得できないときだけ警告を出す。正常時は何も表示しない。 */
function updateKeyStateNotice() {
  const wrap = document.getElementById("keystateWarning");
  const el = document.getElementById("keystateNotice");
  if (!wrap || !el) return;
  if (es.isAvailable() === false) {
    el.textContent =
      "キー状態を取得できません（" +
      (es.getLastError() || "原因不明") +
      "）。「選択の合成方法で判定」への切り替えを推奨します。";
    wrap.className = "warning";
  } else {
    el.textContent = "";
    wrap.className = "warning hidden";
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function syncSectionVisibility() {
  const map = {
    keyboardOptions: settings.modifierSource === "keyboard",
    eventOptions: settings.modifierSource === "event",
    panelOptions: settings.modifierSource === "panel",
  };
  Object.keys(map).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.className = map[id] ? "sub" : "sub hidden";
  });
}

function describeState() {
  if (!settings.enabled) return "無効";
  if (settings.selectionOnly && settings.modifierSource === "panel") {
    return settings.panelMode === "fill"
      ? "待機中 / 選択範囲を残すだけ"
      : "待機中 / 選択範囲を削除";
  }
  if (settings.selectionOnly) {
    return "待機中 / 通常=選択範囲を残す・修飾キー=削除";
  }
  if (settings.modifierSource === "panel") {
    return settings.panelMode === "fill"
      ? "待機中 / 選択範囲を塗りつぶし"
      : "待機中 / 選択範囲を削除";
  }
  if (settings.modifierSource === "keyboard") {
    const name =
      settings.deleteKey === "altKey"
        ? "Alt"
        : settings.deleteKey === "shiftKey"
        ? "Shift"
        : "Ctrl / Cmd";
    return "待機中 / 通常=塗りつぶし・" + name + "=削除";
  }
  const key = settings.deleteTrigger === "addTo" ? "Shift" : "Alt";
  return "待機中 / 通常=塗りつぶし・" + key + "=削除";
}

function applySettingsToUI() {
  const set = (id, prop, value) => {
    const el = document.getElementById(id);
    if (el) el[prop] = value;
  };
  set("enabled", "checked", settings.enabled);
  set("opacity", "value", settings.opacity);
  set("strokeBorder", "checked", settings.strokeBorder);
  set("selectionOnly", "checked", settings.selectionOnly);
  set("modifierSource", "value", settings.modifierSource);
  set("deleteKey", "value", settings.deleteKey);
  set("deleteTrigger", "value", settings.deleteTrigger);
  set("panelMode", "value", settings.panelMode);
  set("lassoOnly", "checked", settings.lassoOnly);
  set("oneUndo", "checked", settings.oneUndo);

  syncSectionVisibility();
  setStatus(describeState());
}

function bindUI() {
  const on = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
  };

  const commit = () => {
    saveSettings();
    setStatus(describeState());
  };

  on("enabled", "change", (e) => {
    settings.enabled = !!e.target.checked;
    commit();
  });
  on("opacity", "change", (e) => {
    const value = Number(e.target.value);
    if (!Number.isNaN(value)) settings.opacity = value;
    commit();
  });
  on("strokeBorder", "change", (e) => {
    settings.strokeBorder = !!e.target.checked;
    commit();
  });
  on("selectionOnly", "change", (e) => {
    settings.selectionOnly = !!e.target.checked;
    commit();
  });
  on("modifierSource", "change", (e) => {
    settings.modifierSource = e.target.value;
    syncSectionVisibility();
    commit();
  });
  on("deleteKey", "change", (e) => {
    settings.deleteKey = e.target.value;
    commit();
  });
  on("deleteTrigger", "change", (e) => {
    settings.deleteTrigger = e.target.value;
    commit();
  });
  on("panelMode", "change", (e) => {
    settings.panelMode = e.target.value;
    commit();
  });
  on("lassoOnly", "change", (e) => {
    settings.lassoOnly = !!e.target.checked;
    commit();
  });
  on("oneUndo", "change", (e) => {
    settings.oneUndo = !!e.target.checked;
    commit();
  });
  on("recheck", "click", () => {
    warmUpKeyState();
  });
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

entrypoints.setup({
  panels: {
    lassoDraw: {
      show() {},
      menuItems: [{ id: "toggleEnabled", label: "有効 / 無効を切り替え" }],
      invokeMenu(id) {
        if (id === "toggleEnabled") {
          settings.enabled = !settings.enabled;
          applySettingsToUI();
          saveSettings();
        }
      },
    },
  },
});

(async () => {
  await loadSettings();
  bindUI();
  applySettingsToUI();
  try {
    await action.addNotificationListener(WATCHED_EVENTS, onSelectionEvent);
  } catch (e) {
    setStatus("イベント監視を開始できませんでした: " + errorMessage(e), true);
  }
  try {
    await action.addNotificationListener([SCRIPT_EVENT], onScriptEvent);
  } catch (e) {
    setStatus("ショートカット監視を開始できませんでした: " + errorMessage(e), true);
  }
  // 起動直後は Photoshop 側も忙しいので少し待ってから温める
  setTimeout(warmUpKeyState, 1500);
})();
