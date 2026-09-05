(function () {
  "use strict";

  // =====================================================================
  //  NfcStats — statistiche SchoolBank (premi/richiami) per Panoramica Prof.
  //  Modulo indipendente: si collega da solo a SchoolBank in sola lettura
  //  tramite FirebaseService (vedi firebase-service.js), non tocca Firebase
  //  Classroom Manager né il progetto del questionario.
  //
  //  Stile: usa le classi definite in nfc-stats.css (prefisso "nfc-"),
  //  che replicano 1:1 la palette e i componenti di SchoolBank stesso
  //  (podio, card, pillole) — così questo tab ha l'identità visiva
  //  dell'app a cui appartengono davvero questi dati, invece di
  //  mimetizzarsi con lo stile del resto di Panoramica Prof.
  // =====================================================================

  let lastContainer = null;
  let lastCtx = null;

  // Dati grezzi dell'ultimo fetch da SchoolBank (cache: cambiare anno
  // scolastico o espandere una classifica non richiede un nuovo fetch).
  let cache = null; // { schoolId, classes, transactions, warnings, currencySymbol }

  let selectedSchoolYear = null; // es. "2025/2026"
  const expanded = { classes: false, rewards: false, warnings: false };

  // ---------------------------------------------------------------------
  // UTILITÀ
  // ---------------------------------------------------------------------
  function escHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function toDate(timestamp) {
    if (!timestamp) return null;
    if (typeof timestamp.toDate === "function") return timestamp.toDate();
    const d = new Date(timestamp);
    return isNaN(d.getTime()) ? null : d;
  }

  // Anno scolastico italiano: 1 settembre - 31 agosto.
  function schoolYearLabelOf(date) {
    const year = date.getFullYear();
    const month = date.getMonth(); // 0=Gen ... 8=Set
    return month >= 8 ? `${year}/${year + 1}` : `${year - 1}/${year}`;
  }

  function schoolYearBounds(label) {
    const startYear = parseInt(String(label).split("/")[0], 10);
    return {
      start: new Date(startYear, 8, 1, 0, 0, 0, 0),
      end: new Date(startYear + 1, 7, 31, 23, 59, 59, 999)
    };
  }

  function currentSchoolYearLabel() {
    return schoolYearLabelOf(new Date());
  }

  function fmtAmount(n, symbol) {
    const rounded = Math.round((n || 0) * 100) / 100;
    return `${symbol || "$"}${rounded}`;
  }

  // ---------------------------------------------------------------------
  // PODIO + CLASSIFICA (stile SchoolBank: podio per i primi 3, righe per
  // il resto, "mostra tutti" per andare oltre i primi 5).
  // ---------------------------------------------------------------------
  function rankRowHTML(item, rank, max, barColor) {
    const pct = Math.max(6, Math.round((item.value / max) * 100));
    return `
      <div class="nfc-rank-row">
        <div class="nfc-rank-num">${rank}</div>
        <div class="nfc-rank-info">
          <div class="nfc-rank-name">${escHtml(item.label)}</div>
          <div class="nfc-rank-bar"><span style="width:${pct}%;background:${barColor}"></span></div>
        </div>
        <div class="nfc-rank-value">${escHtml(item.displayValue != null ? item.displayValue : item.value)}</div>
      </div>`;
  }

  function leaderboardHTML(items, opts) {
    opts = opts || {};
    if (!items.length) return `<p class="nfc-empty">${opts.emptyText || "Ancora nessun dato disponibile."}</p>`;

    const max = Math.max(...items.map((it) => it.value), 1);
    const medals = ["🥇", "🥈", "🥉"];
    const top3 = items.slice(0, 3);
    const next2 = items.slice(3, 5);
    const rest = items.slice(5);
    const isExpanded = !!opts.expanded;

    const podiumHtml = top3.map((it, i) => {
      const pct = Math.max(8, Math.round((it.value / max) * 100));
      return `
        <div class="nfc-podium-card nfc-podium-${i + 1}">
          <div class="nfc-podium-top">
            <span class="nfc-podium-medal">${medals[i]}</span>
            <span class="nfc-podium-name" title="${escHtml(it.label)}">${escHtml(it.label)}</span>
          </div>
          <div class="nfc-podium-value">${escHtml(it.displayValue != null ? it.displayValue : it.value)}</div>
          <div class="nfc-podium-bar"><span style="width:${pct}%;background:${opts.barColor}"></span></div>
        </div>`;
    }).join("");

    const next2Html = next2.map((it, i) => rankRowHTML(it, i + 4, max, opts.barColor)).join("");
    const restHtml = rest.map((it, i) => rankRowHTML(it, i + 6, max, opts.barColor)).join("");
    const listBody = next2Html + (isExpanded ? restHtml : "");

    const toggleBtn = rest.length
      ? `<div class="nfc-toggle-row">
           <button type="button" class="nfc-btn nfc-btn-ghost" data-toggle-expand="${escHtml(opts.key)}">
             ${isExpanded ? "⬆️ Mostra solo i primi 5" : `⬇️ Mostra tutt${opts.allSuffix || "i"} (${items.length})`}
           </button>
         </div>`
      : "";

    return `
      <div class="nfc-podium-row">${podiumHtml}</div>
      ${listBody ? `<div class="nfc-rank-list">${listBody}</div>` : ""}
      ${toggleBtn}`;
  }

  function sectionWrap(title, insight, bodyHTML) {
    return `
      <div class="nfc-section">
        <h3 class="nfc-section-title">${title}</h3>
        ${insight ? `<p class="nfc-insight">${insight}</p>` : ""}
        ${bodyHTML}
      </div>`;
  }

  // ---------------------------------------------------------------------
  // AGGREGAZIONE DATI
  // ---------------------------------------------------------------------
  function filterByYear(list, label) {
    if (!label) return list;
    const { start, end } = schoolYearBounds(label);
    return list.filter((item) => {
      const d = toDate(item.timestamp);
      if (!d) return false;
      return d >= start && d <= end;
    });
  }

  function buildClassNameMap(classes) {
    const map = new Map();
    (classes || []).forEach((c) => { if (c && c.id) map.set(c.id, c.name || c.id); });
    return map;
  }

  function topClassesByEarnings(transactions, classNameById, currencySymbol) {
    const rewards = transactions.filter((t) => (t.amount || 0) > 0);
    const totals = new Map(); // classId -> amount
    rewards.forEach((t) => {
      const key = t.classId || "—";
      totals.set(key, (totals.get(key) || 0) + t.amount);
    });
    return [...totals.entries()]
      .map(([classId, amount]) => ({
        label: classNameById.get(classId) || "Classe sconosciuta",
        value: amount,
        displayValue: fmtAmount(amount, currencySymbol)
      }))
      .sort((a, b) => b.value - a.value);
  }

  function topStudentsByRewardCount(transactions) {
    const rewards = transactions.filter((t) => (t.amount || 0) > 0);
    const counts = new Map(); // studentId -> { name, count }
    rewards.forEach((t) => {
      const key = t.studentId || t.studentName;
      if (!key) return;
      const existing = counts.get(key) || { name: t.studentName || "Alunno", count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    });
    return [...counts.values()]
      .map((s) => ({ label: s.name, value: s.count, displayValue: s.count }))
      .sort((a, b) => b.value - a.value);
  }

  function topStudentsByWarningCount(warnings) {
    const counts = new Map();
    warnings.forEach((w) => {
      const key = w.studentId || w.studentName;
      if (!key) return;
      const existing = counts.get(key) || { name: w.studentName || "Alunno", count: 0 };
      existing.count += 1;
      counts.set(key, existing);
    });
    return [...counts.values()]
      .map((s) => ({ label: s.name, value: s.count, displayValue: s.count }))
      .sort((a, b) => b.value - a.value);
  }

  // ---------------------------------------------------------------------
  // COSTRUZIONE PAGINA
  // ---------------------------------------------------------------------
  function availableSchoolYears(transactions, warnings) {
    const years = new Set();
    [...transactions, ...warnings].forEach((item) => {
      const d = toDate(item.timestamp);
      if (d) years.add(schoolYearLabelOf(d));
    });
    years.add(currentSchoolYearLabel());
    return [...years].sort().reverse();
  }

  function heroHTML(years, totals) {
    const yearChips = years.map((y) => `
      <button type="button" class="nfc-year-btn${selectedSchoolYear === y ? " is-selected" : ""}" data-pick-year="${escHtml(y)}">${escHtml(y)}</button>
    `).join("");

    return `
      <div class="nfc-hero">
        <div class="nfc-kpis">
          <div class="nfc-stat-card">
            <div class="nfc-stat-icon primary">⭐</div>
            <div>
              <div class="nfc-stat-value">${totals.rewardCount}</div>
              <div class="nfc-stat-label">Premi dati</div>
            </div>
          </div>
          <div class="nfc-stat-card">
            <div class="nfc-stat-icon danger">⚠️</div>
            <div>
              <div class="nfc-stat-value">${totals.warningCount}</div>
              <div class="nfc-stat-label">Richiami dati</div>
            </div>
          </div>
          <div class="nfc-stat-card">
            <div class="nfc-stat-icon success">🏦</div>
            <div>
              <div class="nfc-stat-value">${fmtAmount(totals.totalEarned, totals.currencySymbol)}</div>
              <div class="nfc-stat-label">Totale guadagnato</div>
            </div>
          </div>
        </div>
        <div class="nfc-year-switch">${yearChips}</div>
      </div>`;
  }

  function emptyStateHTML(message) {
    return `
      <div class="nfc-section">
        <p class="nfc-empty nfc-empty-big">${escHtml(message)}</p>
      </div>`;
  }

  function connectPromptHTML() {
    return `
      <div class="nfc-section">
        <p class="nfc-empty nfc-empty-big">
          Collega SchoolBank per vedere le statistiche su premi e richiami.
        </p>
        <div class="nfc-toggle-row">
          <button type="button" class="nfc-btn nfc-btn-primary" data-connect-schoolbank="1">🔗 Connetti a SchoolBank</button>
        </div>
      </div>`;
  }

  function buildHTML() {
    if (!cache) return "";

    const { classes, transactions, warnings, currencySymbol } = cache;
    const classNameById = buildClassNameMap(classes);

    const years = availableSchoolYears(transactions, warnings);
    if (!selectedSchoolYear || !years.includes(selectedSchoolYear)) {
      selectedSchoolYear = years.includes(currentSchoolYearLabel()) ? currentSchoolYearLabel() : years[0];
    }

    const txInYear = filterByYear(transactions, selectedSchoolYear);
    const warningsInYear = filterByYear(warnings, selectedSchoolYear);

    const rewardCount = txInYear.filter((t) => (t.amount || 0) > 0).length;
    const totalEarned = txInYear.filter((t) => (t.amount || 0) > 0).reduce((sum, t) => sum + t.amount, 0);

    const classItems = topClassesByEarnings(txInYear, classNameById, currencySymbol);
    const rewardItems = topStudentsByRewardCount(txInYear);
    const warningItems = topStudentsByWarningCount(warningsInYear);

    const classesTop = classItems[0];
    const rewardsTop = rewardItems[0];
    const warningsTop = warningItems[0];

    const classesSection = sectionWrap(
      "🏫 Classe più attiva",
      classesTop ? `Nell'anno scolastico ${escHtml(selectedSchoolYear)}, la classe che ha guadagnato di più è <strong>${escHtml(classesTop.label)}</strong> (${escHtml(classesTop.displayValue)}).` : "",
      leaderboardHTML(classItems, {
        key: "classes",
        expanded: expanded.classes,
        barColor: "linear-gradient(90deg, #9333EA, #7E22CE)",
        emptyText: "Nessun premio registrato in questo anno scolastico."
      })
    );

    const rewardsSection = sectionWrap(
      "⭐ Chi riceve più premi",
      rewardsTop ? `<strong>${escHtml(rewardsTop.label)}</strong> ha ricevuto più premi di chiunque altro (${rewardsTop.value}).` : "",
      leaderboardHTML(rewardItems, {
        key: "rewards",
        expanded: expanded.rewards,
        barColor: "linear-gradient(90deg, #9333EA, #F553A6)",
        allSuffix: "i",
        emptyText: "Nessun premio registrato in questo anno scolastico."
      })
    );

    const warningsSection = sectionWrap(
      "⚠️ Chi riceve più richiami",
      warningsTop ? `<strong>${escHtml(warningsTop.label)}</strong> ha ricevuto più richiami di chiunque altro (${warningsTop.value}).` : "",
      leaderboardHTML(warningItems, {
        key: "warnings",
        expanded: expanded.warnings,
        barColor: "linear-gradient(90deg, #E74C3C, #C0392B)",
        allSuffix: "i",
        emptyText: "Nessun richiamo registrato in questo anno scolastico."
      })
    );

    return heroHTML(years, { rewardCount, warningCount: warningsInYear.length, totalEarned, currencySymbol })
      + classesSection + rewardsSection + warningsSection;
  }

  // ---------------------------------------------------------------------
  // EVENTI
  // ---------------------------------------------------------------------
  function wireEvents(container) {
    container.querySelectorAll("[data-pick-year]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedSchoolYear = btn.dataset.pickYear;
        paint();
      });
    });
    container.querySelectorAll("[data-toggle-expand]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.toggleExpand;
        expanded[key] = !expanded[key];
        paint();
      });
    });
    container.querySelectorAll("[data-connect-schoolbank]").forEach((btn) => {
      btn.addEventListener("click", () => connectAndLoad());
    });
  }

  function paint() {
    if (!lastContainer) return;
    lastContainer.innerHTML = buildHTML();
    wireEvents(lastContainer);
  }

  async function loadData() {
    lastContainer.innerHTML = `<div class="nfc-section"><p class="nfc-empty"><span class="nfc-spinner"></span>Caricamento statistiche SchoolBank…</p></div>`;
    try {
      const data = await window.FirebaseService.fetchSchoolBankData();
      cache = { ...data, currencySymbol: data.currencySymbol || "$" };
      selectedSchoolYear = null; // ricalcola l'anno scolastico di default sui nuovi dati
      paint();
    } catch (error) {
      console.error("Errore caricamento statistiche SchoolBank:", error);
      lastContainer.innerHTML = emptyStateHTML("Errore nel caricamento delle statistiche SchoolBank: " + error.message);
    }
  }

  async function connectAndLoad() {
    try {
      await window.FirebaseService.signInSchoolBank();
      await loadData();
    } catch (error) {
      console.error("Errore di collegamento a SchoolBank:", error);
      lastContainer.innerHTML = emptyStateHTML("Collegamento a SchoolBank non riuscito: " + error.message);
    }
  }

  // ---------------------------------------------------------------------
  // API PUBBLICA
  // ---------------------------------------------------------------------
  function render(container, ctx) {
    lastContainer = container;
    lastCtx = ctx || {};
    container.classList.add("nfc-stats-view");

    if (!window.FirebaseService || typeof window.FirebaseService.isSchoolBankConnected !== "function") {
      container.innerHTML = emptyStateHTML("FirebaseService non è pronto (manca la connessione a SchoolBank).");
      return;
    }

    if (window.FirebaseService.isSchoolBankConnected()) {
      loadData();
    } else {
      container.innerHTML = connectPromptHTML();
      wireEvents(container);
    }
  }

  window.NfcStats = { render };
})();