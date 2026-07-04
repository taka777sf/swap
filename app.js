(function () {
  "use strict";

  const MAX_ITEMS = 5;
  const WEEKDAYS = ["月", "火", "水", "木", "金"];

  const KEY_ITEMS = "swap-calendar-items";
  const KEY_ENTRIES = "swap-calendar-entries-v2"; // { itemId: { dateKey: amount } }
  const KEY_INITIAL = "swap-calendar-initial-v2"; // { itemId: number }
  const KEY_MANUAL_LOTS = "swap-calendar-manual-lots"; // { itemId: { dateKey: lots } }
  const KEY_LAST_BACKUP = "swap-calendar-last-backup"; // ISO timestamp string

  // legacy (single-item) keys from the first version, used for one-time migration
  const LEGACY_ENTRIES = "swap-calendar-entries";
  const LEGACY_INITIAL = "swap-calendar-initial-carry";

  const $app = document.getElementById("app");

  const today = new Date();
  let state = {
    viewY: today.getFullYear(),
    viewM: today.getMonth(),
    items: [],
    activeItemId: null,
    entries: {},      // itemId -> { dateKey: amount }
    initialCarry: {}, // itemId -> number
    manualLots: {},   // itemId -> { dateKey: lots }  (bulk/manual lot purchases, outside the yen threshold)
    showItemSettings: false,
    showAddItem: false,
    persistStatus: "unknown", // "unknown" | "granted" | "denied" | "unsupported"
    lastBackupAt: null,
  };
  let saveTimer = null;
  let saveIndicatorTimer = null;

  // ---------- persistent storage (best-effort, reduces eviction risk) ----------
  async function requestPersistentStorage() {
    try {
      if (!navigator.storage || !navigator.storage.persist) {
        state.persistStatus = "unsupported";
        return;
      }
      const already = await navigator.storage.persisted();
      if (already) {
        state.persistStatus = "granted";
      } else {
        const granted = await navigator.storage.persist();
        state.persistStatus = granted ? "granted" : "denied";
      }
    } catch (e) {
      state.persistStatus = "unsupported";
    }
    render();
  }

  // ---------- storage / migration ----------
  function uid() {
    return "item-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function defaultItems() {
    return [{ id: uid(), name: "TRY/JPYスワップ", thresholdYen: 2000, lotStep: 0.1, unitLabel: "ロット", initialLots: 0 }];
  }

  function loadState() {
    let items = null, entries = null, initial = null, manualLots = null;
    try { const r = localStorage.getItem(KEY_ITEMS); if (r) items = JSON.parse(r); } catch (e) {}
    try { const r = localStorage.getItem(KEY_ENTRIES); if (r) entries = JSON.parse(r); } catch (e) {}
    try { const r = localStorage.getItem(KEY_INITIAL); if (r) initial = JSON.parse(r); } catch (e) {}
    try { const r = localStorage.getItem(KEY_MANUAL_LOTS); if (r) manualLots = JSON.parse(r); } catch (e) {}

    if (!items) {
      // check for legacy single-item data to migrate
      let legacyEntries = null, legacyInitial = 0;
      try { const r = localStorage.getItem(LEGACY_ENTRIES); if (r) legacyEntries = JSON.parse(r); } catch (e) {}
      try { const r = localStorage.getItem(LEGACY_INITIAL); if (r !== null) legacyInitial = Number(r) || 0; } catch (e) {}

      items = defaultItems();
      const firstId = items[0].id;
      entries = { [firstId]: legacyEntries || {} };
      initial = { [firstId]: legacyInitial };
    }

    if (!entries) entries = {};
    if (!initial) initial = {};
    if (!manualLots) manualLots = {};
    items.forEach((it) => {
      if (!entries[it.id]) entries[it.id] = {};
      if (initial[it.id] === undefined) initial[it.id] = 0;
      if (!manualLots[it.id]) manualLots[it.id] = {};
    });

    state.items = items;
    state.entries = entries;
    state.initialCarry = initial;
    state.manualLots = manualLots;
    state.activeItemId = items[0].id;

    try {
      state.lastBackupAt = localStorage.getItem(KEY_LAST_BACKUP);
    } catch (e) {
      state.lastBackupAt = null;
    }
  }

  function persistAll(indicator) {
    if (indicator) setSaveIndicator("saving");
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY_ITEMS, JSON.stringify(state.items));
        localStorage.setItem(KEY_ENTRIES, JSON.stringify(state.entries));
        localStorage.setItem(KEY_INITIAL, JSON.stringify(state.initialCarry));
        localStorage.setItem(KEY_MANUAL_LOTS, JSON.stringify(state.manualLots));
        if (indicator) setSaveIndicator("saved");
      } catch (e) {
        if (indicator) setSaveIndicator("idle");
      }
    }, 350);
  }

  function setSaveIndicator(mode) {
    const el = document.getElementById("save-indicator");
    if (!el) return;
    el.className = "save-indicator " + mode;
    el.textContent = mode === "saving" ? "● 保存中…" : mode === "saved" ? "✓ 保存済み" : "";
    if (saveIndicatorTimer) clearTimeout(saveIndicatorTimer);
    if (mode === "saved") saveIndicatorTimer = setTimeout(() => setSaveIndicator("idle"), 1200);
  }

  // ---------- backup / restore ----------
  function exportBackup() {
    const payload = {
      type: "swap-calendar-backup",
      version: 3,
      exportedAt: new Date().toISOString(),
      items: state.items,
      entries: state.entries,
      initialCarry: state.initialCarry,
      manualLots: state.manualLots,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = `${today.getFullYear()}${pad2(today.getMonth() + 1)}${pad2(today.getDate())}`;
    a.href = url;
    a.download = `swap-calendar-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    try {
      const now = new Date().toISOString();
      localStorage.setItem(KEY_LAST_BACKUP, now);
      state.lastBackupAt = now;
      render();
    } catch (e) {}
  }

  function importBackupFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.items) || typeof data.entries !== "object") {
          alert("バックアップファイルの形式が正しくありません。");
          return;
        }
        const ok = window.confirm(
          `バックアップを復元します（${data.exportedAt ? "作成日: " + data.exportedAt.slice(0, 10) : "日時不明"}）。\n現在のデータは上書きされます。よろしいですか？`
        );
        if (!ok) return;
        state.items = data.items;
        state.entries = data.entries || {};
        state.initialCarry = data.initialCarry || {};
        state.manualLots = data.manualLots || {};
        state.items.forEach((it) => {
          if (!state.entries[it.id]) state.entries[it.id] = {};
          if (state.initialCarry[it.id] === undefined) state.initialCarry[it.id] = 0;
          if (!state.manualLots[it.id]) state.manualLots[it.id] = {};
        });
        state.activeItemId = state.items[0] ? state.items[0].id : null;
        persistAll(true);
        render();
      } catch (e) {
        alert("読み込みに失敗しました。ファイルが壊れている可能性があります。");
      }
    };
    reader.readAsText(file);
  }

  // ---------- helpers ----------
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dateKey(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
  function fmtYen(n) {
    const sign = n < 0 ? "-" : "";
    return sign + "¥" + Math.abs(Math.round(n)).toLocaleString("ja-JP");
  }
  function fmtUnit(n, step, label) {
    const decimals = step < 1 ? String(step).split(".")[1].length : 0;
    return (Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals)).toFixed(decimals) + label;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtNumTrim(n) {
    const r = Math.round((Number(n) || 0) * 100) / 100;
    return String(r);
  }

  // total holdings (initial + auto-earned + manual purchases) for one item
  function totalHeldForItem(item, schedule) {
    const manual = state.manualLots[item.id] || {};
    const manualTotal = Object.values(manual).reduce((s, v) => s + (Number(v) || 0), 0);
    return {
      manualTotal,
      total: (Number(item.initialLots) || 0) + schedule.totalUnits + manualTotal,
    };
  }

  // group all items' holdings by unit label, so mismatched units (ロット / 個 / 垢...) don't get summed together
  function computeGroupedHoldings(items, entriesByItem, initialCarryByItem, manualLotsByItem) {
    const groups = {}; // label -> total
    items.forEach((it) => {
      const entries = entriesByItem[it.id] || {};
      const initialCarry = initialCarryByItem[it.id] || 0;
      const sched = computeSchedule(entries, initialCarry, it.thresholdYen, it.lotStep);
      const manual = manualLotsByItem[it.id] || {};
      const manualTotal = Object.values(manual).reduce((s, v) => s + (Number(v) || 0), 0);
      const total = (Number(it.initialLots) || 0) + sched.totalUnits + manualTotal;
      groups[it.unitLabel] = (groups[it.unitLabel] || 0) + total;
    });
    return Object.keys(groups).map((label) => ({ label, total: groups[label] }));
  }

  function getItem(id) { return state.items.find((it) => it.id === id); }

  // sum every item's raw entry for a given date, across all items
  function computeCombinedByDate(items, entriesByItem) {
    const combined = {};
    items.forEach((it) => {
      const entries = entriesByItem[it.id] || {};
      Object.keys(entries).forEach((k) => {
        const amt = Number(entries[k]) || 0;
        combined[k] = (combined[k] || 0) + amt;
      });
    });
    return combined;
  }

  function computeSchedule(entries, initialCarry, thresholdYen, lotStep) {
    const keys = Object.keys(entries)
      .filter((k) => entries[k] !== undefined && entries[k] !== null && entries[k] !== "")
      .sort();
    const perDay = {};
    let running = Number(initialCarry) || 0;
    let totalUnits = 0;
    let totalAmount = 0;
    for (const k of keys) {
      const amt = Number(entries[k]) || 0;
      totalAmount += amt;
      running += amt;
      let unitsGained = 0;
      if (thresholdYen > 0 && running >= thresholdYen) {
        const whole = Math.floor(running / thresholdYen);
        unitsGained = whole * lotStep;
        running -= whole * thresholdYen;
        totalUnits += unitsGained;
      }
      perDay[k] = { amount: amt, carryAfter: running, unitsGained };
    }
    return { perDay, totalUnits, totalAmount, finalCarry: running, sortedKeys: keys };
  }

  function carryAsOf(perDay, sortedKeys, boundaryKeyInclusive, initialCarry) {
    let carry = Number(initialCarry) || 0;
    for (const k of sortedKeys) {
      if (k > boundaryKeyInclusive) break;
      carry = perDay[k].carryAfter;
    }
    return carry;
  }

  // ---------- rendering ----------
  function render() {
    const item = getItem(state.activeItemId) || state.items[0];
    if (!item) { $app.innerHTML = `<div class="loading">項目がありません</div>`; return; }
    const entries = state.entries[item.id] || {};
    const initialCarry = state.initialCarry[item.id] || 0;
    const schedule = computeSchedule(entries, initialCarry, item.thresholdYen, item.lotStep);
    const manualLots = state.manualLots[item.id] || {};
    const { manualTotal, total: totalHeld } = totalHeldForItem(item, schedule);
    const { viewY, viewM } = state;

    const firstOfMonth = new Date(viewY, viewM, 1);
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const mondayOffset = (firstOfMonth.getDay() + 6) % 7; // 0=Mon start-of-week offset
    const totalCells = Math.ceil((daysInMonth + mondayOffset) / 7) * 7;

    const cells = [];
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - mondayOffset + 1;
      cells.push({ dayNum, inMonth: dayNum >= 1 && dayNum <= daysInMonth, weekdayIdx: i % 7 }); // 0=Mon..6=Sun
    }
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7)); // each week = [Mon..Sun]

    const monthKeyPrefix = `${viewY}-${pad2(viewM + 1)}`;
    const monthKeys = schedule.sortedKeys.filter((k) => k.startsWith(monthKeyPrefix));
    const monthTotal = monthKeys.reduce((s, k) => s + schedule.perDay[k].amount, 0);
    const monthUnits = monthKeys.reduce((s, k) => s + schedule.perDay[k].unitsGained, 0);
    const monthManualLots = Object.keys(manualLots)
      .filter((k) => k.startsWith(monthKeyPrefix))
      .reduce((s, k) => s + (Number(manualLots[k]) || 0), 0);
    const monthUnitsCombined = monthUnits + monthManualLots;
    const lastDayKey = dateKey(viewY, viewM, daysInMonth);
    const carryAtMonthEnd = carryAsOf(schedule.perDay, schedule.sortedKeys, lastDayKey, initialCarry);
    const monthLabel = `${viewY}年${viewM + 1}月`;
    const isCurrentMonth = viewY === today.getFullYear() && viewM === today.getMonth();
    const todayKey = dateKey(today.getFullYear(), today.getMonth(), today.getDate());

    const combinedByDate = computeCombinedByDate(state.items, state.entries);
    const monthCombinedTotal = Object.keys(combinedByDate)
      .filter((k) => k.startsWith(monthKeyPrefix))
      .reduce((s, k) => s + combinedByDate[k], 0);
    const showCombined = state.items.length > 1;
    const groupedHoldings = showCombined
      ? computeGroupedHoldings(state.items, state.entries, state.initialCarry, state.manualLots)
      : [];

    let html = "";

    const persistLabel =
      state.persistStatus === "granted" ? "🛡 永続保存 有効" :
      state.persistStatus === "denied" ? "🛡 永続保存 未許可" :
      state.persistStatus === "unsupported" ? "" : "";
    const persistColor =
      state.persistStatus === "granted" ? "var(--green)" :
      state.persistStatus === "denied" ? "var(--text-faint)" : "var(--text-faint)";

    html += `
      <div class="header">
        <div>
          <h1>スワップ<span class="accent">積立</span>トラッカー</h1>
          <p>項目ごとに「○円貯まるごとに○単位」を管理・自動繰越</p>
        </div>
        <div class="header-actions">
          <span id="save-indicator" class="save-indicator"></span>
          ${persistLabel ? `<span class="persist-badge" style="color:${persistColor}">${persistLabel}</span>` : ""}
          <button class="icon-btn" id="export-btn" title="バックアップを書き出す">⇩ 保存</button>
          <button class="icon-btn" id="import-btn" title="バックアップから復元">⇧ 復元</button>
          <input type="file" id="import-file" accept="application/json" style="display:none" />
        </div>
      </div>`;

    const daysSinceBackup = state.lastBackupAt
      ? Math.floor((today.getTime() - new Date(state.lastBackupAt).getTime()) / 86400000)
      : null;
    const backupReminderHtml = (daysSinceBackup === null || daysSinceBackup >= 14) ? `
        <div class="backup-reminder">
          ${daysSinceBackup === null ? "まだバックアップを書き出していません。" : `最後のバックアップから${daysSinceBackup}日経っています。`}
          「⇩ 保存」でJSONファイルを書き出しておくと安心です。
        </div>` : "";

    html += `<div class="item-tabs">`;
    state.items.forEach((it) => {
      html += `<button class="item-tab ${it.id === item.id ? "active" : ""}" data-item="${it.id}">${esc(it.name)}</button>`;
    });
    if (state.items.length < MAX_ITEMS) {
      html += `<button class="item-tab add" id="add-item-btn">＋ 項目追加</button>`;
    }
    html += `<button class="item-tab settings" id="toggle-item-settings">⚙</button>`;
    html += `</div>`;

    if (state.showAddItem) {
      html += `
        <div class="item-form">
          <div class="item-form-title">新しい項目を追加</div>
          <div class="item-form-grid">
            <label>項目名<input id="new-item-name" type="text" placeholder="例: せどり利益" maxlength="20" /></label>
            <label>閾値（円）<input id="new-item-threshold" type="number" value="2000" /></label>
            <label>加算単位<input id="new-item-step" type="number" step="0.01" value="0.1" /></label>
            <label>単位ラベル<input id="new-item-unit" type="text" value="ロット" maxlength="6" /></label>
            <label>初期保有数（任意）<input id="new-item-initial-lots" type="number" step="0.01" value="0" /></label>
          </div>
          <div class="item-form-actions">
            <button class="nav-btn" id="cancel-add-item">キャンセル</button>
            <button class="nav-btn primary" id="save-add-item">追加する</button>
          </div>
        </div>`;
    }

    if (state.showItemSettings) {
      html += `
        <div class="item-form">
          <div class="item-form-title">「${esc(item.name)}」の設定</div>
          <div class="item-form-grid">
            <label>項目名<input id="edit-item-name" type="text" value="${esc(item.name)}" maxlength="20" /></label>
            <label>閾値（円）<input id="edit-item-threshold" type="number" value="${item.thresholdYen}" /></label>
            <label>加算単位<input id="edit-item-step" type="number" step="0.01" value="${item.lotStep}" /></label>
            <label>単位ラベル<input id="edit-item-unit" type="text" value="${esc(item.unitLabel)}" maxlength="6" /></label>
            <label>初期保有数（任意）<input id="edit-item-initial-lots" type="number" step="0.01" value="${Number(item.initialLots) || 0}" /></label>
          </div>
          <div class="item-form-actions">
            ${state.items.length > 1 ? `<button class="nav-btn danger" id="delete-item-btn">この項目を削除</button>` : `<span></span>`}
            <div style="display:flex; gap:8px;">
              <button class="nav-btn" id="cancel-item-settings">閉じる</button>
              <button class="nav-btn primary" id="save-item-settings">保存</button>
            </div>
          </div>
        </div>`;
    }

    html += `
      <div class="stats">
        <div class="stat-chip">
          <span class="label">今月合計（${esc(item.name)}）</span>
          <span class="value" style="color:${monthTotal >= 0 ? "var(--green)" : "var(--red)"}">${fmtYen(monthTotal)}</span>
        </div>
        ${showCombined ? `
        <div class="stat-chip combined">
          <span class="label">今月合計（全項目）</span>
          <span class="value" style="color:${monthCombinedTotal >= 0 ? "var(--green)" : "var(--red)"}">${fmtYen(monthCombinedTotal)}</span>
          <span class="sub">${state.items.length}項目の合計</span>
        </div>` : ""}
        <div class="stat-chip">
          <span class="label">今月獲得（${esc(item.unitLabel)}）</span>
          <span class="value" style="color:var(--gold)">+${fmtUnit(monthUnitsCombined, item.lotStep, item.unitLabel)}</span>
          ${monthManualLots > 0 ? `<span class="sub">内 購入分 +${fmtUnit(monthManualLots, item.lotStep, item.unitLabel)}</span>` : ""}
        </div>
        <div class="stat-chip">
          <span class="label">繰越残高（月末時点）</span>
          <span class="value">${fmtYen(carryAtMonthEnd)}</span>
          <span class="sub">次まで ${fmtYen(Math.max(0, item.thresholdYen - carryAtMonthEnd))}</span>
        </div>
        <div class="stat-chip">
          <span class="label">保有合計（${esc(item.unitLabel)}）</span>
          <div class="dual-value">
            <span class="value" style="color:var(--gold)">${fmtUnit(totalHeld, item.lotStep, item.unitLabel)}</span>
          </div>
          <span class="sub">初期${fmtUnit(Number(item.initialLots) || 0, item.lotStep, item.unitLabel)} + 自動${fmtUnit(schedule.totalUnits, item.lotStep, item.unitLabel)}${manualTotal ? ` + 購入${fmtUnit(manualTotal, item.lotStep, item.unitLabel)}` : ""}</span>
        </div>
        ${showCombined ? `
        <div class="stat-chip combined">
          <span class="label">全項目 保有合計</span>
          <span class="value" style="color:var(--gold)">${groupedHoldings.map((g) => `${fmtNumTrim(g.total)}${esc(g.label)}`).join(" / ")}</span>
          <span class="sub">${state.items.length}項目の合計</span>
        </div>` : ""}
      </div>`;

    const initialCarryBarHtml = `
      <div class="initial-carry-bar">
        <span class="lbl">記録開始前の繰越残高（任意）</span>
        <input type="number" id="initial-carry-input" value="${esc(initialCarry)}" />
        <span class="note">円（この項目についてすでに運用中なら現時点の繰越額を入力）</span>
      </div>`;

    html += `
      <div class="month-nav">
        <button class="nav-btn" id="prev-month">← 前月</button>
        <div class="month-center">
          <span class="month-label">${monthLabel}</span>
          ${!isCurrentMonth ? `<button class="nav-btn small" id="go-today">今月へ</button>` : ""}
        </div>
        <button class="nav-btn" id="next-month">次月 →</button>
      </div>`;

    html += `<div class="cal-wrap">`;
    html += `<div class="weekday-row">`;
    WEEKDAYS.forEach((w) => {
      html += `<div>${w}</div>`;
    });
    html += `<div class="wk">週計</div></div>`;

    weeks.forEach((week) => {
      let weekTotal = 0, weekUnits = 0, hasAnyEntry = false, weekCombinedTotal = 0;
      week.forEach((c) => {
        if (!c.inMonth) return;
        const k = dateKey(viewY, viewM, c.dayNum);
        const info = schedule.perDay[k];
        if (info) { weekTotal += info.amount; weekUnits += info.unitsGained; hasAnyEntry = true; }
        weekCombinedTotal += combinedByDate[k] || 0;
      });

      html += `<div class="week-row">`;
      week.filter((c) => c.weekdayIdx <= 4).forEach((c) => { // Mon(0)..Fri(4) only
        if (!c.inMonth) { html += `<div class="day-cell empty"></div>`; return; }
        const k = dateKey(viewY, viewM, c.dayNum);
        const info = schedule.perDay[k];
        const amount = info ? info.amount : null;
        const carryAfter = info ? info.carryAfter : null;
        const unitsGained = info ? info.unitsGained : 0;
        const isToday = k === todayKey;
        const progressFrac = carryAfter !== null ? Math.max(0, Math.min(1, carryAfter / item.thresholdYen)) : 0;
        const amtCls = amount === null ? "" : amount > 0 ? "pos" : amount < 0 ? "neg" : "";
        const rawVal = entries[k] !== undefined ? entries[k] : "";
        const combinedAmt = combinedByDate[k] || 0;
        const manualLotVal = Number(manualLots[k]) || 0;

        html += `
          <div class="day-cell ${isToday ? "today" : ""}">
            <div class="top-row">
              <span class="day-num">${c.dayNum}</span>
              <span class="badge-group">
                ${unitsGained > 0 ? `<span class="lot-badge">+${fmtUnit(unitsGained, item.lotStep, item.unitLabel)}</span>` : ""}
                <button class="manual-lot-btn ${manualLotVal ? "has-value" : ""}" data-key="${k}" title="まとめ購入を記録">${manualLotVal ? `🛒${fmtNumTrim(manualLotVal)}` : "🛒"}</button>
              </span>
            </div>
            <input class="amount ${amtCls}" type="number" inputmode="decimal" placeholder="—"
              data-key="${k}" value="${esc(rawVal)}" />
            ${showCombined ? `<span class="combined-label">計 ${combinedAmt !== 0 ? fmtYen(combinedAmt) : "—"}</span>` : ""}
            <div class="bottom">
              <div class="progress-track"><div class="progress-fill" style="width:${progressFrac * 100}%"></div></div>
              <span class="carry-label">繰越 ${carryAfter !== null ? fmtYen(carryAfter) : "—"}</span>
            </div>
          </div>`;
      });

      html += `
        <div class="week-total ${hasAnyEntry ? "has-entry" : ""}">
          <span class="lbl">週計</span>
          <span class="val ${weekTotal > 0 ? "pos" : weekTotal < 0 ? "neg" : ""}">${hasAnyEntry ? fmtYen(weekTotal) : "—"}</span>
          ${weekUnits > 0 ? `<span class="lots">+${fmtUnit(weekUnits, item.lotStep, item.unitLabel)}</span>` : ""}
          ${showCombined ? `<span class="combined-total-line">全計 ${weekCombinedTotal !== 0 ? fmtYen(weekCombinedTotal) : "—"}</span>` : ""}
        </div>`;
      html += `</div>`;
    });

    html += `</div>`;

    html += initialCarryBarHtml;
    html += backupReminderHtml;

    html += `
      <p class="footnote">
        各日のマスに金額を入力すると自動保存されます。繰越が閾値に達した日は金色バッジで表示し、余剰分は翌日以降へ繰り越されます。
        データはこの端末に保存されます。定期的に「⇩ 保存」でバックアップファイルを書き出しておくことをおすすめします。
      </p>`;

    $app.innerHTML = html;
    attachHandlers();
  }

  // ---------- handlers ----------
  function attachHandlers() {
    document.getElementById("prev-month").onclick = () => {
      if (state.viewM === 0) { state.viewY -= 1; state.viewM = 11; } else { state.viewM -= 1; }
      render();
    };
    document.getElementById("next-month").onclick = () => {
      if (state.viewM === 11) { state.viewY += 1; state.viewM = 0; } else { state.viewM += 1; }
      render();
    };
    const todayBtn = document.getElementById("go-today");
    if (todayBtn) todayBtn.onclick = () => {
      state.viewY = today.getFullYear();
      state.viewM = today.getMonth();
      render();
    };

    document.querySelectorAll(".item-tab[data-item]").forEach((btn) => {
      btn.onclick = () => {
        state.activeItemId = btn.dataset.item;
        state.showItemSettings = false;
        state.showAddItem = false;
        render();
      };
    });

    const addBtn = document.getElementById("add-item-btn");
    if (addBtn) addBtn.onclick = () => { state.showAddItem = true; state.showItemSettings = false; render(); };

    const toggleSettingsBtn = document.getElementById("toggle-item-settings");
    if (toggleSettingsBtn) toggleSettingsBtn.onclick = () => {
      state.showItemSettings = !state.showItemSettings;
      state.showAddItem = false;
      render();
    };

    const cancelAdd = document.getElementById("cancel-add-item");
    if (cancelAdd) cancelAdd.onclick = () => { state.showAddItem = false; render(); };

    const saveAdd = document.getElementById("save-add-item");
    if (saveAdd) saveAdd.onclick = () => {
      const name = document.getElementById("new-item-name").value.trim();
      const threshold = Number(document.getElementById("new-item-threshold").value);
      const step = Number(document.getElementById("new-item-step").value);
      const unit = document.getElementById("new-item-unit").value.trim() || "件";
      const initialLots = Number(document.getElementById("new-item-initial-lots").value) || 0;
      if (!name) { alert("項目名を入力してください。"); return; }
      if (state.items.length >= MAX_ITEMS) { alert(`項目は最大${MAX_ITEMS}個までです。`); return; }
      if (!threshold || threshold <= 0) { alert("閾値は1円以上で入力してください。"); return; }
      const id = uid();
      state.items.push({ id, name, thresholdYen: threshold, lotStep: step || 0.1, unitLabel: unit, initialLots });
      state.entries[id] = {};
      state.manualLots[id] = {};
      state.initialCarry[id] = 0;
      state.activeItemId = id;
      state.showAddItem = false;
      persistAll(true);
      render();
    };

    const cancelSettings = document.getElementById("cancel-item-settings");
    if (cancelSettings) cancelSettings.onclick = () => { state.showItemSettings = false; render(); };

    const saveSettings = document.getElementById("save-item-settings");
    if (saveSettings) saveSettings.onclick = () => {
      const item = getItem(state.activeItemId);
      const name = document.getElementById("edit-item-name").value.trim();
      const threshold = Number(document.getElementById("edit-item-threshold").value);
      const step = Number(document.getElementById("edit-item-step").value);
      const unit = document.getElementById("edit-item-unit").value.trim() || "件";
      const initialLots = Number(document.getElementById("edit-item-initial-lots").value) || 0;
      if (!name) { alert("項目名を入力してください。"); return; }
      if (!threshold || threshold <= 0) { alert("閾値は1円以上で入力してください。"); return; }
      item.name = name; item.thresholdYen = threshold; item.lotStep = step || 0.1; item.unitLabel = unit; item.initialLots = initialLots;
      state.showItemSettings = false;
      persistAll(true);
      render();
    };

    const deleteBtn = document.getElementById("delete-item-btn");
    if (deleteBtn) deleteBtn.onclick = () => {
      const item = getItem(state.activeItemId);
      const ok = window.confirm(`「${item.name}」を削除します。この項目のデータは失われます。よろしいですか？`);
      if (!ok) return;
      state.items = state.items.filter((it) => it.id !== item.id);
      delete state.entries[item.id];
      delete state.initialCarry[item.id];
      delete state.manualLots[item.id];
      state.activeItemId = state.items[0] ? state.items[0].id : null;
      state.showItemSettings = false;
      persistAll(true);
      render();
    };

    const initInput = document.getElementById("initial-carry-input");
    if (initInput) {
      initInput.addEventListener("blur", () => {
        state.initialCarry[state.activeItemId] = Number(initInput.value) || 0;
        persistAll(true);
        render();
      });
      initInput.addEventListener("keydown", (e) => { if (e.key === "Enter") initInput.blur(); });
    }

    document.querySelectorAll(".day-cell input.amount").forEach((input) => {
      input.addEventListener("blur", () => {
        const key = input.dataset.key;
        const val = input.value;
        const itemEntries = state.entries[state.activeItemId];
        if (val === "") { delete itemEntries[key]; }
        else {
          const n = Number(val);
          if (!Number.isNaN(n)) itemEntries[key] = n;
        }
        persistAll(true);
        render();
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    });

    document.querySelectorAll(".manual-lot-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key;
        const item = getItem(state.activeItemId);
        const manual = state.manualLots[state.activeItemId] || (state.manualLots[state.activeItemId] = {});
        const current = manual[key] !== undefined ? manual[key] : "";
        const input = window.prompt(
          `${key} にまとめて購入した${item.unitLabel}数を入力してください（削除する場合は空欄でOK）`,
          current === "" ? "" : String(current)
        );
        if (input === null) return; // cancelled
        if (input.trim() === "") {
          delete manual[key];
        } else {
          const n = Number(input);
          if (Number.isNaN(n)) { alert("数値を入力してください。"); return; }
          if (n === 0) { delete manual[key]; } else { manual[key] = n; }
        }
        persistAll(true);
        render();
      });
    });

    document.getElementById("export-btn").onclick = exportBackup;
    const importBtn = document.getElementById("import-btn");
    const importFile = document.getElementById("import-file");
    importBtn.onclick = () => importFile.click();
    importFile.onchange = (e) => {
      const file = e.target.files[0];
      if (file) importBackupFile(file);
      importFile.value = "";
    };
  }

  // ---------- init ----------
  loadState();
  render();
  requestPersistentStorage();
})();
