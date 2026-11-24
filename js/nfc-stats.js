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
  let selectedClassName = null; // es. "2B"; null = tutte le classi
  const expanded = { classes: false, rewards: false, warnings: false, balances: false };

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

  // Chi ha più soldi: saldo netto dell'anno (premi meno spese) per alunno.
  function topStudentsByBalance(transactions, currencySymbol) {
    const totals = new Map(); // studentId -> { name, amount }
    transactions.forEach((t) => {
      const key = t.studentId || t.studentName;
      if (!key) return;
      const existing = totals.get(key) || { name: t.studentName || "Alunno", amount: 0 };
      existing.amount += t.amount || 0;
      totals.set(key, existing);
    });
    return [...totals.values()]
      .map((s) => ({ label: s.name, value: s.amount, displayValue: fmtAmount(s.amount, currencySymbol) }))
      .filter((s) => s.value > 0)
      .sort((a, b) => b.value - a.value);
  }

  // Id delle classi SchoolBank con quel nome (di solito una sola).
  function classIdsByName(classes, name) {
    const wanted = String(name || "").trim().toUpperCase();
    return new Set((classes || []).filter((c) => String(c.name || "").trim().toUpperCase() === wanted).map((c) => c.id));
  }

  // I richiami possono non avere classId: in quel caso ricavo la classe
  // dalle transazioni dello stesso alunno.
  function warningsOfClass(warnings, transactions, classIds) {
    const classOfStudent = new Map();
    transactions.forEach((t) => { if (t.studentId && t.classId) classOfStudent.set(t.studentId, t.classId); });
    return warnings.filter((w) => classIds.has(w.classId || classOfStudent.get(w.studentId)));
  }

  // --- Check di classe (es. "Notebook check in") ---------------------------
  // Il Notebook Check di SchoolBank assegna, per ogni alunno: richiamo
  // "No NB" o "No HW", oppure un premio Ugly $0 / Ok $10 / Pretty $20 /
  // Stunning $40 / Best $100. Non so in quale campo SchoolBank scriva la
  // motivazione, quindi riconosco le voci cercando "notebook"/"NB"/"HW"
  // in tutti i campi testuali del documento.
  const NB_LEVELS = [
    { amount: 0, label: "Ugly", emoji: "😖" },
    { amount: 10, label: "Ok", emoji: "📒" },
    { amount: 20, label: "Pretty", emoji: "🎨" },
    { amount: 40, label: "Stunning", emoji: "✨" },
    { amount: 100, label: "Best", emoji: "😍" }
  ];

  function docText(item) {
    return Object.values(item || {}).filter((v) => typeof v === "string").join(" | ");
  }
  const NB_RE = /notebook|note\s?book|\bNB\b/i;
  const HW_RE = /homework|\bHW\b|compiti/i;

  function isNoHW(w) {
    return HW_RE.test(docText(w)) && !/\bNB\b|notebook/i.test(docText(w));
  }

  function dotMark(color, title) {
    return `<span title="${title}" style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${color};margin:2px 3px 2px 0;"></span>`;
  }

  // Righe "nome + segni + totale", raggruppate per totale (dal più alto):
  // ogni gruppo mostra al massimo 2 alunni, gli altri vanno in un menu a tendina.
  // opts: { total(e), marks(e) -> html, noun: [singolare, plurale] }
  function groupedRowsHTML(rows, opts) {
    const MAX_VISIBLE = 2;
    const rowHTML = (e) => `
      <div style="display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,0.06);">
        <div style="flex:0 0 38%;min-width:110px;font-weight:600;">${escHtml(e.name)}</div>
        <div style="flex:1;display:flex;flex-wrap:wrap;align-items:center;">${opts.marks(e)}</div>
        <div style="flex:0 0 auto;font-weight:700;">${opts.total(e)}</div>
      </div>`;
    const groups = new Map(); // totale -> alunni
    rows.forEach((e) => {
      const t = opts.total(e);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(e);
    });
    return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([t, list]) => {
      const visible = list.slice(0, MAX_VISIBLE).map(rowHTML).join("");
      const hidden = list.slice(MAX_VISIBLE);
      if (!hidden.length) return visible;
      return `${visible}
        <details style="margin:2px 0;">
          <summary style="cursor:pointer;padding:4px 0;font-size:0.88rem;font-weight:600;opacity:0.75;">+ ${hidden.length} altr${hidden.length === 1 ? "o" : "i"} con ${t} ${opts.noun[t === 1 ? 0 : 1]}</summary>
          ${hidden.map(rowHTML).join("")}
        </details>`;
    }).join("");
  }

  // Un alunno per riga, con un pallino per ogni richiamo: giallo = No NB,
  // rosso = No HW. Ordinati da chi ne ha di più a chi ne ha di meno.
  function warningDotsHTML(nbWarn) {
    const byStudent = new Map();
    nbWarn.forEach((w) => {
      const key = w.studentId || w.studentName;
      if (!key) return;
      const e = byStudent.get(key) || { name: w.studentName || "Alunno", nb: 0, hw: 0 };
      if (isNoHW(w)) e.hw += 1; else e.nb += 1;
      byStudent.set(key, e);
    });
    const rows = [...byStudent.values()]
      .sort((a, b) => (b.nb + b.hw) - (a.nb + a.hw) || a.name.localeCompare(b.name, "it"));
    if (!rows.length) return "";

    const body = groupedRowsHTML(rows, {
      total: (e) => e.nb + e.hw,
      marks: (e) => dotMark("#F5C518", "No NB").repeat(e.nb) + dotMark("#E74C3C", "No HW").repeat(e.hw),
      noun: ["richiamo", "richiami"]
    });
    const legend = `<p class="nfc-insight">${dotMark("#F5C518", "No NB")} No NB &nbsp; ${dotMark("#E74C3C", "No HW")} No HW</p>`;
    return sectionWrap("🔴 Richiami Notebook Check per alunno", "", legend + body);
  }

  // Premi del Notebook Check: ❤️ = Best ($100), pallino giallo = Stunning
  // ($40), pallino fucsia = Pretty ($20). Un alunno per riga.
  function rewardDotsHTML(nbTx) {
    const byStudent = new Map();
    nbTx.forEach((t) => {
      const key = t.studentId || t.studentName;
      if (!key) return;
      const amount = Math.round(t.amount || 0);
      if (amount !== 100 && amount !== 40 && amount !== 20) return;
      const e = byStudent.get(key) || { name: t.studentName || "Alunno", best: 0, stunning: 0, pretty: 0 };
      if (amount === 100) e.best += 1; else if (amount === 40) e.stunning += 1; else e.pretty += 1;
      byStudent.set(key, e);
    });
    const total = (e) => e.best + e.stunning + e.pretty;
    const rows = [...byStudent.values()]
      .sort((a, b) => total(b) - total(a) || b.best - a.best || a.name.localeCompare(b.name, "it"));
    if (!rows.length) return "";

    const HEART = `<span title="Best" style="margin:0 3px 0 0;font-size:15px;line-height:1;">❤️</span>`;
    const body = groupedRowsHTML(rows, {
      total,
      marks: (e) => HEART.repeat(e.best) + dotMark("#F5C518", "Stunning").repeat(e.stunning) + dotMark("#E91E8C", "Pretty").repeat(e.pretty),
      noun: ["premio", "premi"]
    });
    const legend = `<p class="nfc-insight">${HEART} Best ($100) &nbsp; ${dotMark("#F5C518", "Stunning")} Stunning ($40) &nbsp; ${dotMark("#E91E8C", "Pretty")} Pretty ($20)</p>`;
    return sectionWrap("🏆 Premi Notebook Check per alunno", "", legend + body);
  }

  function classNotebookHTML(className, txInClass, warningsInClass, currencySymbol) {
    const nbTx = txInClass.filter((t) => NB_RE.test(docText(t)) && (t.amount || 0) >= 0);
    const nbWarn = warningsInClass.filter((w) => NB_RE.test(docText(w)) || HW_RE.test(docText(w)));

    if (!nbTx.length && !nbWarn.length) {
      const sample = txInClass[0] || warningsInClass[0];
      const fields = sample ? Object.keys(sample).join(", ") : "";
      return sectionWrap("📒 Notebook Check", "", `
        <p class="nfc-empty">Non trovo voci di Notebook Check per la classe ${escHtml(className)} in questo anno scolastico.</p>
        ${fields ? `<p class="nfc-insight">Campi che SchoolBank salva su un premio/richiamo: ${escHtml(fields)}. Se la parola "notebook" o "NB" non compare in nessuno, dimmi quale campo identifica il Notebook Check.</p>` : ""}`);
    }

    const levelCounts = NB_LEVELS.map((l) => ({ ...l, n: nbTx.filter((t) => Math.round(t.amount || 0) === l.amount).length }));
    const other = nbTx.length - levelCounts.reduce((a, l) => a + l.n, 0);
    const noHW = nbWarn.filter(isNoHW).length;
    const noNB = nbWarn.length - noHW;

    const pill = (emoji, label, n) => `<span class="nfc-stat-card" style="display:inline-flex;margin:0 8px 8px 0;padding:8px 14px;"><span>${emoji} ${escHtml(label)}: <strong>${n}</strong></span></span>`;
    const pills = [
      ...levelCounts.map((l) => pill(l.emoji, `${l.label} ${fmtAmount(l.amount, currencySymbol)}`, l.n)),
      pill("⚠️", "No NB", noNB),
      pill("📚", "No HW", noHW)
    ].join("");

    // Chi ha preso di più / chi ha più richiami sul notebook
    const earned = new Map();
    nbTx.forEach((t) => {
      const key = t.studentId || t.studentName;
      if (!key) return;
      const e = earned.get(key) || { name: t.studentName || "Alunno", amount: 0, count: 0 };
      e.amount += t.amount || 0; e.count += 1;
      earned.set(key, e);
    });
    const best = [...earned.values()].sort((a, b) => b.amount - a.amount).slice(0, 5)
      .map((e) => `${escHtml(e.name)} (${fmtAmount(e.amount, currencySymbol)})`).join(", ");
    const warned = new Map();
    nbWarn.forEach((w) => {
      const key = w.studentId || w.studentName;
      if (!key) return;
      const e = warned.get(key) || { name: w.studentName || "Alunno", n: 0 };
      e.n += 1; warned.set(key, e);
    });
    const worst = [...warned.values()].sort((a, b) => b.n - a.n).slice(0, 5)
      .map((e) => `${escHtml(e.name)} (${e.n})`).join(", ");

    return sectionWrap("📒 Notebook Check", `Classe ${escHtml(className)}: ${nbTx.length} premi e ${nbWarn.length} richiami da Notebook Check.`, `
      <div>${pills}</div>
      ${other ? `<p class="nfc-insight">${other} premi con un importo diverso da quelli del Notebook Check.</p>` : ""}
      ${best ? `<p class="nfc-insight"><strong>Notebook migliori:</strong> ${best}</p>` : ""}
      ${worst ? `<p class="nfc-insight"><strong>Più richiami (No NB / No HW):</strong> ${worst}</p>` : ""}`) + warningDotsHTML(nbWarn) + rewardDotsHTML(nbTx);
  }

  // ---------------------------------------------------------------------
  // COSTRUZIONE PAGINA
  // ---------------------------------------------------------------------
  function classChipsHTML(classes) {
    const names = [...new Set((classes || []).map((c) => String(c.name || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, "it", { numeric: true }));
    const chips = names.map((n) => `
      <button type="button" class="nfc-year-btn${selectedClassName === n ? " is-selected" : ""}" data-pick-class="${escHtml(n)}">${escHtml(n)}</button>`).join("");
    return `<div class="nfc-year-switch">
      <button type="button" class="nfc-year-btn${!selectedClassName ? " is-selected" : ""}" data-pick-class="">Tutte le classi</button>${chips}
    </div>`;
  }

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

    let txInYear = filterByYear(transactions, selectedSchoolYear);
    let warningsInYear = filterByYear(warnings, selectedSchoolYear);

    // Filtro per classe: solo transazioni e richiami degli alunni di quella classe.
    if (selectedClassName) {
      const ids = classIdsByName(classes, selectedClassName);
      warningsInYear = warningsOfClass(warningsInYear, txInYear, ids);
      txInYear = txInYear.filter((t) => ids.has(t.classId));
    }

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

    const balanceItems = topStudentsByBalance(txInYear, currencySymbol);
    const balanceTop = balanceItems[0];
    const balancesSection = sectionWrap(
      "💰 Chi ha più soldi",
      balanceTop ? `<strong>${escHtml(balanceTop.label)}</strong> ha il saldo più alto dell'anno (${escHtml(balanceTop.displayValue)}, premi meno spese).` : "",
      leaderboardHTML(balanceItems, {
        key: "balances",
        expanded: expanded.balances,
        barColor: "linear-gradient(90deg, #10B981, #059669)",
        allSuffix: "i",
        emptyText: "Nessun saldo positivo in questo anno scolastico."
      })
    );

    const hero = heroHTML(years, { rewardCount, warningCount: warningsInYear.length, totalEarned, currencySymbol });
    const picker = `<div class="nfc-hero" style="margin-top:-8px;">${classChipsHTML(classes)}</div>`;

    // Vista di classe: niente classifica tra classi, ma saldi e check della classe.
    if (selectedClassName) {
      return hero + picker + rewardsSection + warningsSection + balancesSection + classNotebookHTML(selectedClassName, txInYear, warningsInYear, currencySymbol);
    }
    return hero + picker + classesSection + rewardsSection + warningsSection + balancesSection;
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
    container.querySelectorAll("[data-pick-class]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cls = btn.dataset.pickClass || null;
        selectedClassName = cls && selectedClassName !== cls ? cls : null;
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