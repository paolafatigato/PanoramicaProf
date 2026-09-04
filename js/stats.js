(function () {
  "use strict";

  // =====================================================================
  //  PanoramicaStats — pagina iniziale con le statistiche dei questionari.
  //  Modulo indipendente: riceve i dati e alcune funzioni/costanti già
  //  definite in app.js (vedi ctx in render()), non tocca Firebase.
  // =====================================================================

  // Piccola lista di parole da ignorare nella nuvola di hobby (articoli,
  // congiunzioni, riempitivi tipici delle risposte libere dei bambini).
  const STOPWORDS = new Set([
    "e", "ed", "o", "od", "di", "del", "dello", "della", "dei", "degli", "delle",
    "con", "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
    "al", "allo", "alla", "ai", "agli", "alle", "in", "su", "per", "tra", "fra",
    "anche", "molto", "molti", "molte", "tanto", "tanti", "tante", "cose", "cosa",
    "mi", "ci", "si", "che", "non", "più", "meno", "sempre", "spesso", "volte",
    "tutto", "tutti", "tutte", "quando", "come", "dove", "loro", "suo", "sua",
    "mio", "mia", "miei", "mie", "questo", "questa", "faccio", "fare", "fa"
  ]);

  // Campi che sappiamo già trattare esplicitamente altrove nella pagina:
  // servono per capire quali altri campi del questionario sono "extra"
  // (es. un eventuale "figlio unico" aggiunto in futuro al questionario)
  // e proporli automaticamente, senza doverli conoscere in anticipo.
  const BASE_KNOWN_FIELDS = [
    "id", "isTestProfile", "className", "class", "classe",
    "firstName", "lastName", "fullName", "displayName",
    "photoUrl", "preferredName", "teacherNotes", "linkedResponseId", "lastEditedAt",
    "favoriteSubject", "favoriteSubjectReason",
    "englishFocus", "englishGoal", "englishWorry", "englishConfidence", "englishYears",
    "livesWith", "languagesHome", "studyPlace", "studyHelper", "studyOther",
    "screenTime", "homeworkStart", "bedTime", "wakeTime", "sleepHours",
    "hobbySummary", "weekendLove",
    "goodAt1", "goodAt2", "goodAt3", "difficult1", "difficult2", "difficult3",
    "bestLessons",
    "noteHomeLife", "noteStudyHabits", "noteSleepScreen",
    "noteHobbiesMain", "noteHobbiesGood", "noteHobbiesHard", "noteEnglishIntro"
  ];

  // Piccolo dizionario per etichette più leggibili quando un campo extra
  // viene rilevato automaticamente (se non è nel dizionario, l'etichetta
  // viene generata dal nome del campo).
  const FRIENDLY_LABELS = {
    onlyChild: "Figlio unico / figlia unica",
    hasSiblings: "Ha fratelli o sorelle",
    siblings: "Fratelli e sorelle",
    numSiblings: "Numero di fratelli/sorelle",
    petsAtHome: "Animali in casa",
    hasPet: "Ha un animale domestico",
    transportToSchool: "Come arriva a scuola",
    booksAtHome: "Libri in casa"
  };

  let lastContainer = null;
  let lastStudents = [];
  let lastCtx = null;
  let viewMode = "all"; // "all" | "class" | "compare"
  let selectedClass = null;

  // ---------------------------------------------------------------------
  // UTILITÀ
  // ---------------------------------------------------------------------
  function fmt1(n) {
    return (Math.round(n * 10) / 10).toFixed(1).replace(".", ",");
  }

  function humanizeFieldName(key) {
    if (FRIENDLY_LABELS[key]) return FRIENDLY_LABELS[key];
    const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  function countBy(students, getValue) {
    const counts = new Map();
    let n = 0;
    students.forEach((s) => {
      const v = getValue(s);
      if (v === undefined || v === null || v === "") return;
      n += 1;
      counts.set(v, (counts.get(v) || 0) + 1);
    });
    return { counts, n };
  }

  function sortedEntries(counts) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function numericSummary(students, key) {
    const values = [];
    students.forEach((s) => {
      const raw = s[key];
      if (raw === undefined || raw === null || raw === "") return;
      const match = String(raw).match(/(\d+(?:[.,]\d+)?)/);
      if (!match) return;
      values.push(parseFloat(match[1].replace(",", ".")));
    });
    if (!values.length) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return { avg: sum / values.length, n: values.length };
  }

  function ratingAverages(pairs, students) {
    return pairs.map(([key, label]) => {
      let sum = 0;
      let n = 0;
      students.forEach((s) => {
        const v = parseInt(s[key], 10) || 0;
        if (v > 0) { sum += v; n += 1; }
      });
      return { key, label, avg: n ? sum / n : 0, n };
    }).sort((a, b) => b.avg - a.avg);
  }

  // ---------------------------------------------------------------------
  // BLOCCHI HTML RIUTILIZZABILI
  // ---------------------------------------------------------------------
  function sectionWrap(title, insight, bodyHTML, extraClass) {
    return `
      <div class="stats-section${extraClass ? ` ${extraClass}` : ""}">
        <h3 class="stats-section-title">${title}</h3>
        ${insight ? `<p class="stats-insight">${insight}</p>` : ""}
        ${bodyHTML}
      </div>`;
  }

  function barListHTML(items, opts) {
    opts = opts || {};
    if (!items.length) return `<p class="stats-empty">${opts.emptyText || "Ancora nessun dato disponibile."}</p>`;
    const total = opts.total || items.reduce((a, [, c]) => a + c, 0);
    const max = Math.max(...items.map(([, c]) => c), 1);
    return `<div class="bar-list">${items.map(([label, count], i) => {
      const pct = total ? Math.round((count / total) * 100) : 0;
      const widthPct = Math.max(6, Math.round((count / max) * 100));
      const color = opts.colorFor ? opts.colorFor(label, i) : (opts.color || "var(--mint-leaf)");
      const clickAttr = opts.dataAttr ? ` data-${opts.dataAttr}="${escAttr(label)}"` : "";
      const clickable = opts.dataAttr ? " bar-row-clickable" : "";
      const crown = opts.crownFirst && i === 0 ? "🏆 " : "";
      return `
        <div class="bar-row${clickable}"${clickAttr} role="${opts.dataAttr ? "button" : ""}" ${opts.dataAttr ? 'tabindex="0"' : ""}>
          <span class="bar-label">${crown}${escHtml(label)}</span>
          <div class="bar-track"><span class="bar-fill" style="width:${widthPct}%;background:${color}"></span></div>
          <span class="bar-value">${count} · ${pct}%</span>
        </div>`;
    }).join("")}</div>`;
  }

  function avgDotsHTML(avg, max) {
    max = max || 5;
    let html = "";
    for (let i = 1; i <= max; i += 1) {
      const filled = avg >= i - 0.25;
      const half = !filled && avg >= i - 0.75;
      html += `<span class="dot${filled ? " filled" : half ? " half" : ""}"></span>`;
    }
    return html;
  }

  function ratedListHTML(rows, opts) {
    opts = opts || {};
    const withData = rows.filter((r) => r.n > 0);
    if (!withData.length) return `<p class="stats-empty">${opts.emptyText || "Ancora nessuna valutazione registrata."}</p>`;
    return `<div class="rate-list stats-rate-list">${withData.map((r) => `
      <div class="rate-row stats-rate-row">
        <span class="rate-label">${escHtml(r.label)}</span>
        <span class="rating-dots">${avgDotsHTML(r.avg, opts.max || 5)}</span>
        <span class="rate-avg-value">${fmt1(r.avg)}/${opts.max || 5} <span class="rate-n">· n=${r.n}</span></span>
      </div>`).join("")}</div>`;
  }

  function tagCloudHTML(students, keys, ctx) {
    const freq = new Map();
    students.forEach((s) => {
      keys.forEach((k) => {
        const raw = ctx.flattenValue ? ctx.flattenValue(s[k]) : (s[k] || "");
        if (!raw) return;
        String(raw).split(/[,;.\n]| e | ed | o /gi).forEach((chunk) => {
          const word = chunk.trim().toLowerCase().replace(/^(il|lo|la|i|gli|le|un|una|uno)\s+/, "");
          if (!word || word.length < 3 || STOPWORDS.has(word)) return;
          freq.set(word, (freq.get(word) || 0) + 1);
        });
      });
    });
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
    if (!top.length) return `<p class="stats-empty">Ancora nessuna risposta sugli hobby.</p>`;
    const maxCount = top[0][1];
    return `<div class="tag-cloud">${top.map(([word, count]) => {
      const tier = Math.max(1, Math.min(5, Math.ceil((count / maxCount) * 5)));
      return `<span class="tag-cloud-item tag-tier-${tier}" title="${count} menzioni">${escHtml(word)}</span>`;
    }).join("")}</div>`;
  }

  function escHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function escAttr(str) { return escHtml(str); }

  // ---------------------------------------------------------------------
  // CAMPI EXTRA AUTO-RILEVATI (es. "figlio unico" se presente nel questionario)
  // ---------------------------------------------------------------------
  function buildExcludeSet(ctx) {
    const known = new Set(BASE_KNOWN_FIELDS);
    (ctx.SUBJECTS || []).forEach(([k]) => { known.add(k); known.add(`${k}Comment`); });
    (ctx.LESSON_STYLES || []).forEach(([k]) => { known.add(k); known.add(`${k}Comment`); });
    (ctx.PERF_SKILLS || []).forEach(([k]) => { known.add(k); known.add(`${k}Note`); });
    return known;
  }

  function detectExtraFields(students, ctx) {
    const known = buildExcludeSet(ctx);
    const valuesByKey = new Map();
    students.forEach((s) => {
      Object.keys(s).forEach((key) => {
        if (known.has(key)) return;
        const raw = s[key];
        if (raw === undefined || raw === null || raw === "") return;
        if (typeof raw === "object") return;
        const value = String(raw).trim();
        if (!value || value.length > 24) return;
        if (!valuesByKey.has(key)) valuesByKey.set(key, new Map());
        const m = valuesByKey.get(key);
        m.set(value, (m.get(value) || 0) + 1);
      });
    });
    const extras = [];
    valuesByKey.forEach((valueMap, key) => {
      const total = [...valueMap.values()].reduce((a, b) => a + b, 0);
      if (total < 2) return;
      if (valueMap.size > 6) return; // troppo variegato: probabilmente testo libero
      extras.push({ key, label: humanizeFieldName(key), entries: sortedEntries(valueMap), total });
    });
    extras.sort((a, b) => b.total - a.total);
    return extras;
  }

  // ---------------------------------------------------------------------
  // SEZIONI STANDARD (usate sia in "Tutti" che in "Per classe")
  // ---------------------------------------------------------------------
  function classDistributionSection(students, ctx) {
    const { counts, n } = countBy(students, (s) => ctx.getClassValue(s));
    const items = sortedEntries(counts).sort((a, b) => ctx.CLASS_LIST.indexOf(a[0]) - ctx.CLASS_LIST.indexOf(b[0]));
    const top = sortedEntries(counts)[0];
    const insight = n
      ? `${n} alunn${n === 1 ? "o" : "i"} monitorat${n === 1 ? "o" : "i"} in tutto${top ? `, la classe più numerosa è ${escHtml(top[0])}` : ""}.`
      : "";
    const body = barListHTML(items, {
      total: n,
      dataAttr: "class",
      colorFor: (label) => ctx.classColor(label)
    });
    return sectionWrap("🏫 Alunni per classe", insight, body);
  }

  function subjectsSection(students, ctx) {
    const favCounts = countBy(students, (s) => ctx.optionLabel(ctx.FAVORITE_SUBJECT_OPTIONS, s.favoriteSubject, ""));
    const favItems = sortedEntries(favCounts.counts);
    const favTop = favItems[0];
    const favInsight = favTop
      ? `La materia scelta più spesso come preferita è <strong>${escHtml(favTop[0])}</strong> (${favTop[1]} alunn${favTop[1] === 1 ? "o" : "i"} su ${favCounts.n}).`
      : "";
    const favBody = barListHTML(favItems, { total: favCounts.n, crownFirst: true, color: "var(--bright-gold)" });

    const rated = ratingAverages(ctx.SUBJECTS, students);
    const ratedTop = rated.find((r) => r.n > 0);
    const ratedInsight = ratedTop
      ? `In base ai voti dati dagli alunni, quella che piace di più in assoluto è <strong>${escHtml(ratedTop.label)}</strong> (${fmt1(ratedTop.avg)}/5).`
      : "";
    const ratedBody = ratedListHTML(rated);

    return sectionWrap("📚 Materie", "", `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Materia preferita</p>
          <p class="stats-insight">${favInsight}</p>
          ${favBody}
        </div>
        <div>
          <p class="stats-subtitle">Quanto piace ciascuna materia</p>
          <p class="stats-insight">${ratedInsight}</p>
          ${ratedBody}
        </div>
      </div>`);
  }

  function lessonsSection(students, ctx) {
    const rated = ratingAverages(ctx.LESSON_STYLES, students);
    const top = rated.find((r) => r.n > 0);
    const insight = top
      ? `Lo stile di lezione più apprezzato è <strong>${escHtml(top.label)}</strong> (${fmt1(top.avg)}/5).`
      : "";
    return sectionWrap("🧑‍🏫 Stili di lezione preferiti", insight, ratedListHTML(rated));
  }

  function hobbiesSection(students, ctx) {
    const body = tagCloudHTML(students, ["hobbySummary", "goodAt1", "goodAt2", "goodAt3"], ctx);
    const placeCounts = countBy(students, (s) => ctx.optionLabel(ctx.STUDY_PLACE_OPTIONS, s.studyPlace, ""));
    const placeItems = sortedEntries(placeCounts.counts);
    const placeBody = barListHTML(placeItems, { total: placeCounts.n, color: "var(--sky-blue)" });
    return sectionWrap("🎨 Tempo libero e studio", "", `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Hobby più menzionati</p>
          <p class="stats-caption">Stima approssimativa dalle risposte libere: parole più ricorrenti, non una categoria chiusa.</p>
          ${body}
        </div>
        <div>
          <p class="stats-subtitle">Dove studiano di solito</p>
          ${placeBody}
        </div>
      </div>`);
  }

  function englishSection(students, ctx) {
    let sum = 0; let n = 0;
    students.forEach((s) => {
      const v = parseInt(s.englishConfidence, 10) || 0;
      if (v > 0) { sum += v; n += 1; }
    });
    const avg = n ? sum / n : 0;
    const confBody = n
      ? `<div class="rated-solo"><span class="rating-dots">${avgDotsHTML(avg, 5)}</span><span class="rate-avg-value">${fmt1(avg)}/5 <span class="rate-n">· n=${n}</span></span></div>`
      : `<p class="stats-empty">Ancora nessuna risposta.</p>`;

    const focusCounts = countBy(students, (s) => ctx.optionLabel(ctx.ENGLISH_FOCUS_OPTIONS, s.englishFocus, ""));
    const focusBody = barListHTML(sortedEntries(focusCounts.counts), { total: focusCounts.n, color: "var(--lilac)" });

    const years = numericSummary(students, "englishYears");
    const yearsText = years
      ? `In media lo studiano da <strong>${fmt1(years.avg)} anni</strong> (n=${years.n}).`
      : "";

    return sectionWrap("💬 Inglese", "", `
      <div class="stats-subgrid stats-subgrid-3">
        <div>
          <p class="stats-subtitle">Quanto si sentono sicuri</p>
          ${confBody}
        </div>
        <div>
          <p class="stats-subtitle">Su cosa vogliono lavorare</p>
          ${focusBody}
        </div>
        <div>
          <p class="stats-subtitle">Da quanto lo studiano</p>
          <p class="stats-insight">${yearsText || "Dati non ancora disponibili."}</p>
        </div>
      </div>`);
  }

  function habitsSection(students, ctx) {
    const screen = numericSummary(students, "screenTime");
    const sleep = numericSummary(students, "sleepHours");
    return sectionWrap("⏰ Abitudini quotidiane", "", `
      <div class="stats-kpis stats-kpis-inline">
        <div class="stat-card">
          <div class="stat-value">${screen ? `${fmt1(screen.avg)} h` : "—"}</div>
          <div class="stat-label">Tempo medio agli schermi ${screen ? `(n=${screen.n})` : ""}</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${sleep ? `${fmt1(sleep.avg)} h` : "—"}</div>
          <div class="stat-label">Ore di sonno medie ${sleep ? `(n=${sleep.n})` : ""}</div>
        </div>
      </div>`);
  }

  function rendimentoSection(students, ctx) {
    const rated = ratingAverages(
      (ctx.PERF_SKILLS || []).map(([k, l]) => [k, l]),
      students
    ).map((r) => {
      const found = (ctx.PERF_SKILLS || []).find(([k]) => k === r.key);
      return { ...r, color: found ? found[2] : "var(--mint-leaf)", max: 10 };
    });
    const withData = rated.filter((r) => r.n > 0);
    if (!withData.length) {
      return sectionWrap("📈 Come li valuti tu", "", `<p class="stats-empty">Non hai ancora valutato nessun alunno nella scheda "Rendimento".</p>`);
    }
    const items = withData.map((r) => [r.label, Math.round(r.avg * 10)]); // su scala 0-100 per la barra
    const body = `<div class="bar-list">${withData.map((r) => `
      <div class="bar-row">
        <span class="bar-label">${escHtml(r.label)}</span>
        <div class="bar-track"><span class="bar-fill" style="width:${Math.max(6, Math.round((r.avg / 10) * 100))}%;background:${r.color}"></span></div>
        <span class="bar-value">${fmt1(r.avg)}/10 <span class="rate-n">· n=${r.n}</span></span>
      </div>`).join("")}</div>`;
    return sectionWrap("📈 Come li valuti tu", "Valutazioni date da te nella scheda \u201cRendimento\u201d di ciascun alunno.", body);
  }

  function extraFieldsSection(students, ctx) {
    const extras = detectExtraFields(students, ctx);
    if (!extras.length) return "";
    const cards = extras.map((extra) => `
      <div class="extra-field-card">
        <p class="stats-subtitle">${escHtml(extra.label)}</p>
        ${barListHTML(extra.entries, { total: extra.total, color: "var(--tiger-flame)" })}
      </div>`).join("");
    return sectionWrap(
      "🔎 Altri dati dal questionario",
      "Campi individuati automaticamente nelle risposte, oltre a quelli già mostrati sopra.",
      `<div class="extra-fields-grid">${cards}</div>`
    );
  }

  function standardSections(students, ctx) {
    return classDistributionSection(students, ctx)
      + subjectsSection(students, ctx)
      + lessonsSection(students, ctx)
      + hobbiesSection(students, ctx)
      + englishSection(students, ctx)
      + habitsSection(students, ctx)
      + rendimentoSection(students, ctx)
      + extraFieldsSection(students, ctx);
  }

  // ---------------------------------------------------------------------
  // CONFRONTO TRA CLASSI: una "pagella" compatta per ciascuna classe
  // ---------------------------------------------------------------------
  function compareCardHTML(cls, students, ctx) {
    const color = ctx.classColor(cls);
    const n = students.length;
    if (!n) {
      return `
        <div class="compare-card" style="--chip-color:${color}">
          <div class="compare-card-head"><span class="compare-class-name">${escHtml(cls)}</span><span class="compare-class-n">0 alunni</span></div>
          <p class="stats-empty">Nessun alunno in questa classe.</p>
        </div>`;
    }
    const favCounts = countBy(students, (s) => ctx.optionLabel(ctx.FAVORITE_SUBJECT_OPTIONS, s.favoriteSubject, ""));
    const favTop = sortedEntries(favCounts.counts)[0];
    const subjRated = ratingAverages(ctx.SUBJECTS, students).filter((r) => r.n > 0);
    const subjAvg = subjRated.length ? subjRated.reduce((a, r) => a + r.avg, 0) / subjRated.length : null;
    const lessonRated = ratingAverages(ctx.LESSON_STYLES, students).filter((r) => r.n > 0);
    const lessonAvg = lessonRated.length ? lessonRated.reduce((a, r) => a + r.avg, 0) / lessonRated.length : null;
    let engSum = 0; let engN = 0;
    students.forEach((s) => { const v = parseInt(s.englishConfidence, 10) || 0; if (v > 0) { engSum += v; engN += 1; } });
    const perfRated = ratingAverages((ctx.PERF_SKILLS || []).map(([k, l]) => [k, l]), students).filter((r) => r.n > 0);
    const perfAvg = perfRated.length ? perfRated.reduce((a, r) => a + r.avg, 0) / perfRated.length : null;

    return `
      <div class="compare-card" style="--chip-color:${color}" data-class="${escAttr(cls)}" role="button" tabindex="0">
        <div class="compare-card-head">
          <span class="compare-class-name">${escHtml(cls)}</span>
          <span class="compare-class-n">${n} alunn${n === 1 ? "o" : "i"}</span>
        </div>
        <dl class="compare-stats">
          <div><dt>Materia preferita</dt><dd>${favTop ? `${escHtml(favTop[0])} (${favTop[1]})` : "—"}</dd></div>
          <div><dt>Media materie</dt><dd>${subjAvg != null ? `${fmt1(subjAvg)}/5` : "—"}</dd></div>
          <div><dt>Media lezioni</dt><dd>${lessonAvg != null ? `${fmt1(lessonAvg)}/5` : "—"}</dd></div>
          <div><dt>Sicurezza inglese</dt><dd>${engN ? `${fmt1(engSum / engN)}/5` : "—"}</dd></div>
          <div><dt>Rendimento medio</dt><dd>${perfAvg != null ? `${fmt1(perfAvg)}/10` : "—"}</dd></div>
        </dl>
      </div>`;
  }

  function compareView(realStudents, ctx) {
    const cards = ctx.CLASS_LIST.map((cls) => {
      const inClass = realStudents.filter((s) => ctx.getClassValue(s) === cls);
      return compareCardHTML(cls, inClass, ctx);
    }).join("");
    return classDistributionSection(realStudents, ctx)
      + sectionWrap(
        "⚖️ Confronto tra classi",
        "Una pagella sintetica per ciascuna classe: clicca su una classe per aprirne l'elenco alunni.",
        `<div class="compare-grid">${cards}</div>`
      );
  }

  // ---------------------------------------------------------------------
  // COSTRUZIONE PAGINA
  // ---------------------------------------------------------------------
  function heroHTML(realStudents, ctx) {
    const classesActive = new Set(realStudents.map((s) => ctx.getClassValue(s)).filter(Boolean)).size;
    const modeBtn = (mode, label) => `<button type="button" class="view-mode-btn${viewMode === mode ? " is-selected" : ""}" data-view-mode="${mode}">${label}</button>`;
    const classPicker = viewMode === "class"
      ? `<div class="stats-class-pick">${ctx.CLASS_LIST.map((c) => `<button type="button" class="choice-chip class-chip${selectedClass === c ? " is-selected" : ""}" data-pick-class="${c}" style="--chip-color:${ctx.classColor(c)}"><span class="class-chip-dot"></span>${c}</button>`).join("")}</div>`
      : "";
    return `
      <div class="stats-hero">
        <div class="stats-kpis">
          <div class="stat-card">
            <div class="stat-value">${realStudents.length}</div>
            <div class="stat-label">Alunni monitorati</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${classesActive}</div>
            <div class="stat-label">Classi con dati</div>
          </div>
        </div>
        <div class="view-mode-switch">
          ${modeBtn("all", "Tutti gli alunni")}
          ${modeBtn("class", "Per classe")}
          ${modeBtn("compare", "Confronto tra classi")}
        </div>
        ${classPicker}
      </div>`;
  }

  function emptyStateHTML() {
    return `
      <div class="stats-hero">
        <div class="stats-kpis">
          <div class="stat-card"><div class="stat-value">0</div><div class="stat-label">Alunni monitorati</div></div>
        </div>
      </div>
      <div class="stats-section">
        <p class="stats-empty stats-empty-big">Non ci sono ancora dati da mostrare. Collega Classroom Manager qui sopra per importare i tuoi alunni, oppure aspetta che compilino il questionario.</p>
      </div>`;
  }

  function buildHTML(students, ctx) {
    const realStudents = (students || []).filter((s) => !s.isTestProfile);
    if (!realStudents.length) return emptyStateHTML();

    if (!selectedClass || !ctx.CLASS_LIST.includes(selectedClass)) {
      selectedClass = ctx.CLASS_LIST.find((c) => realStudents.some((s) => ctx.getClassValue(s) === c)) || ctx.CLASS_LIST[0];
    }

    let body;
    if (viewMode === "compare") {
      body = compareView(realStudents, ctx);
    } else if (viewMode === "class") {
      const inClass = realStudents.filter((s) => ctx.getClassValue(s) === selectedClass);
      body = `<p class="stats-class-heading">Classe ${escHtml(selectedClass)} — ${inClass.length} alunn${inClass.length === 1 ? "o" : "i"}</p>`
        + (inClass.length ? standardSections(inClass, ctx) : `<div class="stats-section"><p class="stats-empty">Nessun alunno in questa classe.</p></div>`);
    } else {
      body = standardSections(realStudents, ctx);
    }

    return heroHTML(realStudents, ctx) + `<div class="stats-body">${body}</div>`;
  }

  // ---------------------------------------------------------------------
  // EVENTI
  // ---------------------------------------------------------------------
  function wireEvents(container, ctx) {
    container.querySelectorAll("[data-view-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        viewMode = btn.dataset.viewMode;
        rerender();
      });
    });
    container.querySelectorAll("[data-pick-class]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedClass = btn.dataset.pickClass;
        rerender();
      });
    });
    container.querySelectorAll(".bar-row-clickable[data-class]").forEach((row) => {
      const go = () => { if (ctx.onOpenClass) ctx.onOpenClass(row.dataset.class); };
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
    container.querySelectorAll(".compare-card[data-class]").forEach((card) => {
      const go = () => { if (ctx.onOpenClass) ctx.onOpenClass(card.dataset.class); };
      card.addEventListener("click", go);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  function render(container, students, ctx) {
    lastContainer = container;
    lastStudents = students || [];
    lastCtx = ctx;
    container.innerHTML = buildHTML(lastStudents, ctx);
    wireEvents(container, ctx);
  }

  function rerender() {
    if (lastContainer) render(lastContainer, lastStudents, lastCtx);
  }

  window.PanoramicaStats = { render };
})();