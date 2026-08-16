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

const settings = {
  enabled: true,
  fillSource: "foregroundColor", // "foregroundColor" | "backgroundColor"
  opacity: 100,
  strokeBorder: false, // 現在のブラシで境界線を描く
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

const NO_DIALOG = { dialogOptions: "dontDisplay" };

function fillCommand() {
  return {
    _obj: "fill",
    using: { _enum: "fillContents", _value: settings.fillSource },
    opacity: { _unit: "percentUnit", _value: settings.opacity },
    mode: { _enum: "blendMode", _value: "normal" },
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

function makeWorkPathCommand() {
  return {
    _obj: "make",
    _target: [{ _ref: "path" }],
    from: { _ref: "selectionClass", _property: "selection" },
    tolerance: { _unit: "pixelsUnit", _value: WORK_PATH_TOLERANCE },
    _options: NO_DIALOG,
  };
}

/**
 * 「パスの境界線を描く」。ツールに設定されている現在のブラシ（サイズ・硬さ・
 * ブラシ先端）がそのまま使われる。
 *
 * using の列挙値は Photoshop の内部ツール ID。ブラシツールの ID は
 * "brushTool" ではなく "paintbrushTool"（charID の "PbTl"）。
 * バージョン差を考慮して候補を順に試し、通ったものを記憶する。
 */
const STROKE_TOOLS = {
  fill: ["paintbrushTool", "brushTool", "pencilTool"],
  delete: ["eraserTool"],
};
const strokeToolCache = {};

function strokePathCommand(toolValue) {
  return {
    _obj: "stroke",
    _target: [{ _ref: "path", _enum: "ordinal", _value: "targetEnum" }],
    using: { _enum: "penTool", _value: toolValue },
    _options: NO_DIALOG,
  };
}

/** 作業用パスの境界線を描く (batchPlay 版)。使えるツール ID を探して記憶する。 */
async function strokeWorkPathViaBatchPlay(mode) {
  const cached = strokeToolCache[mode];
  const candidates = cached ? [cached] : STROKE_TOOLS[mode] || [];
  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    try {
      await play("境界線の描画", strokePathCommand(candidates[i]));
      strokeToolCache[mode] = candidates[i];
      return;
    } catch (e) {
      lastError = e;
    }
  }
  delete strokeToolCache[mode];
  throw lastError || new Error("境界線の描画 / 使用できるツールがありません");
}

/**
 * 作業用パスの削除。
 * 現在のパス (targetEnum) を指す列挙参照が正しい形式。
 * `{_ref:"path", _property:"workPath"}` はパスを「選択」するための参照であり、
 * delete に渡すと「プログラムエラーです」になる。
 * 念のため他の形式もフォールバックとして用意し、通ったものを記憶する。
 */
const DELETE_PATH_TARGETS = [
  [{ _ref: "path", _enum: "ordinal", _value: "targetEnum" }],
  [{ _ref: "path" }],
];
let deletePathTargetIndex = -1;
let deletePathBroken = false;

function deleteWorkPathCommand(target) {
  return { _obj: "delete", _target: target, _options: NO_DIALOG };
}

/** 作業用パスを消す。全ての形式が失敗したら以後は試行しない（毎回エラーダイアログが出るのを防ぐ） */
async function removeWorkPath() {
  if (deletePathBroken) return;
  const indexes =
    deletePathTargetIndex >= 0
      ? [deletePathTargetIndex]
      : DELETE_PATH_TARGETS.map((_, i) => i);
  let lastError = null;
  for (let i = 0; i < indexes.length; i++) {
    try {
      await play("作業用パスの削除", deleteWorkPathCommand(DELETE_PATH_TARGETS[indexes[i]]));
      deletePathTargetIndex = indexes[i];
      return;
    } catch (e) {
      lastError = e;
    }
  }
  deletePathTargetIndex = -1;
  deletePathBroken = true;
  throw lastError || new Error("作業用パスの削除: 不明なエラー");
}

/**
 * 境界線を描く。
 *
 * ExtendScript を優先する。batchPlay の `stroke` はモーダルスコープ内から呼ぶと
 * `{_obj:"error", message:"", result:-128}`（ユーザーがキャンセル）で拒否される
 * 環境があるため。ExtendScript の PathItem.strokePath() にはその制約が無い。
 *
 * 戻り値の deselected が true なら選択解除まで済んでいる。
 */
async function drawBorder(mode) {
  const toolType = mode === "fill" ? "BRUSH" : "ERASER";

  if (es.isAvailable() !== false) {
    const result = await es.strokeSelectionBorder(toolType, WORK_PATH_TOLERANCE);
    if (result === "ok") return { deselected: true };
    if (result !== null) {
      // ExtendScript は動いたが Photoshop 側の処理で失敗した
      const err = new Error("境界線の描画 / " + result);
      err.step = "境界線の描画";
      console.error("[lassoDraw] 境界線の描画 (ExtendScript)", result);
      throw err;
    }
    // result === null: ブリッジ自体が使えないので batchPlay へフォールバック
  }

  await play("作業用パスの作成", makeWorkPathCommand());
  await play("選択解除", deselectCommand());
  await strokeWorkPathViaBatchPlay(mode);
  await removeWorkPath();
  return { deselected: true };
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

function isAllowedTool(toolId) {
  if (!toolId) return true; // 判定できない場合は通す
  if (LASSO_TOOLS.indexOf(toolId) >= 0) return true;
  if (settings.lassoOnly) return false;
  return OTHER_SELECTION_TOOLS.indexOf(toolId) >= 0;
}

function setStatus(text, isError) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.className = isError ? "status error" : "status";
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

async function runOnSelection(plan, replayDescriptor) {
  let mode = plan.mode;
  let commandError = null;
  let strokeError = null;
  let keysMissing = false;

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
          mode === "fill" ? fillCommand() : deleteCommand()
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
        const result = await drawBorder(mode);
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

  if (commandError) {
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

function updateKeyStateNotice() {
  const el = document.getElementById("keystateNotice");
  if (!el) return;
  const state = es.isAvailable();
  if (state === true) {
    el.textContent = "Ctrl 検出: 利用可能 (ExtendScript 経由)";
    el.className = "note ok";
  } else if (state === false) {
    el.textContent =
      "Ctrl 検出: 利用できません（" +
      (es.getLastError() || "原因不明") +
      "）。Shift / Alt 方式への切り替えを推奨します。";
    el.className = "note ng";
  } else {
    el.textContent = "Ctrl 検出: 未確認";
    el.className = "note";
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
  set("fillSource", "value", settings.fillSource);
  set("opacity", "value", settings.opacity);
  set("strokeBorder", "checked", settings.strokeBorder);
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
  on("fillSource", "change", (e) => {
    settings.fillSource = e.target.value;
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
  // 起動直後は Photoshop 側も忙しいので少し待ってから温める
  setTimeout(warmUpKeyState, 1500);
})();
