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
    "mio", "mia", "miei", "mie", "questo", "questa", "faccio", "fare", "fa",
    "and", "or", "with", "the", "my", "to", "of", "a", "an", "i", "love", "like"
  ]);

  let lastContainer = null;
  let lastStudents = [];
  let lastCtx = null;
  let viewMode = "all"; // "all" | "class" | "compare"
  let selectedClass = null;
  let lastHobbyClusters = {}; // { hobbies: [...], goodAt: [...], difficult: [...] }, per il click sulle nuvole

  // ---------------------------------------------------------------------
  // UTILITÀ
  // ---------------------------------------------------------------------
  function fmt1(n) {
    return (Math.round(n * 10) / 10).toFixed(1).replace(".", ",");
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

  // --- Estrazione delle singole menzioni di hobby dai campi liberi -------
  // Separatori: virgole/punti/";" e le congiunzioni più comuni in italiano
  // e inglese ("e", "ed", "o", "and", "or"), così "swimming and dancing"
  // conta come due hobby distinti (swimming, dancing) invece di uno solo.
  function extractHobbyMentions(students, keys, ctx) {
    const mentions = [];
    students.forEach((s) => {
      keys.forEach((k) => {
        const raw = ctx.flattenValue ? ctx.flattenValue(s[k]) : (s[k] || "");
        if (!raw) return;
        String(raw).split(/[,;.\n]|\s+e\s+|\s+ed\s+|\s+o\s+|\s+and\s+|\s+or\s+/gi).forEach((chunk) => {
          const cleaned = chunk
            .trim().toLowerCase()
            .replace(/^(il|lo|la|i|gli|le|un|una|uno|a)\s+/, "")
            .replace(/[^\p{L}\p{N}\s]/gu, "")
            .replace(/\s+/g, " ")
            .trim();
          if (!cleaned || cleaned.length < 3 || STOPWORDS.has(cleaned)) return;
          mentions.push({ studentId: s.id, phrase: cleaned });
        });
      });
    });
    return mentions;
  }

  // --- Raggruppamento delle varianti dello stesso hobby -------------------
  // "play video games" / "play videogames" collassano (stessa parola senza
  // spazi); piccoli refusi ("whith" per "with", plurali) vengono assorbiti
  // con una distanza di edit tollerante. Non unifica sinonimi in lingue o
  // parole diverse (es. "sleeping" e "a dormire"): richiederebbe traduzione,
  // non normalizzazione.
  function squash(str) { return str.replace(/\s+/g, ""); }

  function levenshtein(a, b) {
    const m = a.length; const n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j += 1) dp[j] = j;
    for (let i = 1; i <= m; i += 1) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j += 1) {
        const tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = tmp;
      }
    }
    return dp[n];
  }

  function similarity(a, b) {
    if (!a.length && !b.length) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  function clusterHobbyMentions(mentions) {
    const clusters = []; // { squashKey, variants: Map(phrase->count), studentIds: Set }
    mentions.forEach(({ studentId, phrase }) => {
      const sq = squash(phrase);
      let target = clusters.find((c) => c.squashKey === sq);
      if (!target) {
        target = clusters.find((c) => Math.abs(c.squashKey.length - sq.length) <= 3 && similarity(c.squashKey, sq) >= 0.82);
      }
      if (!target) {
        target = { squashKey: sq, variants: new Map(), studentIds: new Set() };
        clusters.push(target);
      }
      target.variants.set(phrase, (target.variants.get(phrase) || 0) + 1);
      target.studentIds.add(studentId);
    });
    return clusters.map((c) => {
      const bestVariant = [...c.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
      return {
        label: bestVariant,
        count: [...c.variants.values()].reduce((a, b) => a + b, 0),
        studentIds: [...c.studentIds]
      };
    }).sort((a, b) => b.count - a.count);
  }

  function tagCloudHTML(students, keys, ctx, kind, emptyText) {
    const mentions = extractHobbyMentions(students, keys, ctx);
    const clusters = clusterHobbyMentions(mentions).slice(0, 18);
    lastHobbyClusters[kind] = clusters;
    if (!clusters.length) return `<p class="stats-empty">${emptyText || "Ancora nessuna risposta."}</p>`;
    const maxCount = clusters[0].count;
    const variantClass = kind === "difficult" ? " tag-cloud--difficult" : "";
    return `<div class="tag-cloud${variantClass}">${clusters.map((c, i) => {
      const tier = Math.max(1, Math.min(5, Math.ceil((c.count / maxCount) * 5)));
      const n = c.studentIds.length;
      return `<button type="button" class="tag-cloud-item tag-tier-${tier}" data-hobby-kind="${kind}" data-hobby-index="${i}" title="${n} alunn${n === 1 ? "o" : "i"} — clicca per vedere chi">${escHtml(c.label)}</button>`;
    }).join("")}</div>`;
  }

  function escHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function escAttr(str) { return escHtml(str); }

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
      total: students.length,
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
      ? `La materia scelta più spesso come preferita è <strong>${escHtml(favTop[0])}</strong> (${favTop[1]} alunn${favTop[1] === 1 ? "o" : "i"} su ${students.length}).`
      : "";
    const favBody = barListHTML(favItems, { total: students.length, crownFirst: true, color: "var(--bright-gold)" });

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

  function isItalian(nationality) {
    const v = (nationality || "").trim().toLowerCase();
    return v === "italiana" || v === "italiano";
  }

  function originSection(students, ctx) {
    const withNationality = students.filter((s) => (s.nationality || "").trim());
    const nonItalian = withNationality.filter((s) => !isItalian(s.nationality));
    const missing = students.length - withNationality.length;

    if (!nonItalian.length) {
      const insight = withNationality.length
        ? `Tra i ${withNationality.length} alunni con nazionalità indicata, nessuno risulta non italiano al momento.`
        : `La nazionalità non è ancora stata indicata per nessun alunno: puoi aggiungerla dalla scheda, nel tab "Casa e abitudini".`;
      return sectionWrap("🌍 Provenienza e lingua italiana", insight, "");
    }

    const insight = `${nonItalian.length} alunn${nonItalian.length === 1 ? "o" : "i"} non italian${nonItalian.length === 1 ? "o" : "i"} su ${withNationality.length} nazionalità compilate`
      + (missing ? ` (${missing} non ancora indicata${missing === 1 ? "" : "e"}).` : ".");

    const natCounts = countBy(nonItalian, (s) => (s.nationality || "").trim());
    const natBody = barListHTML(sortedEntries(natCounts.counts), { total: students.length, color: "var(--sky-blue)" });

    const years = numericSummary(nonItalian, "yearsInItaly");
    const yearsBody = years
      ? `<p class="stats-insight">In media sono in Italia da <strong>${fmt1(years.avg)} anni</strong> (n=${years.n}).</p>`
      : `<p class="stats-empty">Dati sugli anni in Italia non ancora disponibili.</p>`;

    const levelCounts = countBy(nonItalian, (s) => ctx.optionLabel(ctx.ITALIAN_LEVEL_OPTIONS, s.italianLevel, ""));
    const levelBody = barListHTML(sortedEntries(levelCounts.counts), { total: students.length, color: "var(--mint-leaf)" });

    return sectionWrap("🌍 Provenienza e lingua italiana", insight, `
      <div class="stats-subgrid stats-subgrid-3">
        <div>
          <p class="stats-subtitle">Nazionalità</p>
          ${natBody}
        </div>
        <div>
          <p class="stats-subtitle">Da quanto sono in Italia</p>
          ${yearsBody}
        </div>
        <div>
          <p class="stats-subtitle">Livello di italiano</p>
          ${levelBody}
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
    // "My Hobbies" nel questionario salva un campo per ogni hobby digitato
    // (hobbyName1, hobbyName2, ...): li raccolgo tutti, oltre a hobbySummary
    // per compatibilità con risposte più vecchie.
    const hobbyKeys = new Set(["hobbySummary"]);
    students.forEach((s) => {
      Object.keys(s).forEach((k) => { if (/^hobbyName\d*$/i.test(k)) hobbyKeys.add(k); });
    });
    const body = tagCloudHTML(students, [...hobbyKeys], ctx, "hobbies", "Ancora nessuna risposta sugli hobby.");
    const placeCounts = countBy(students, (s) => ctx.optionLabel(ctx.STUDY_PLACE_OPTIONS, s.studyPlace, ""));
    const placeItems = sortedEntries(placeCounts.counts);
    const placeBody = barListHTML(placeItems, { total: students.length, color: "var(--sky-blue)" });
    return sectionWrap("🎨 Tempo libero e studio", "", `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Hobby più menzionati</p>
          <p class="stats-caption">Stima dalle risposte libere; le varianti molto simili (es. "video games" e "videogames") vengono raggruppate. Clicca su un hobby per vedere chi lo pratica.</p>
          ${body}
        </div>
        <div>
          <p class="stats-subtitle">Dove studiano di solito</p>
          ${placeBody}
        </div>
      </div>`);
  }

  function strengthsSection(students, ctx) {
    const goodBody = tagCloudHTML(students, ["goodAt1", "goodAt2", "goodAt3"], ctx, "goodAt", "Ancora nessuna risposta.");
    const hardBody = tagCloudHTML(students, ["difficult1", "difficult2", "difficult3"], ctx, "difficult", "Ancora nessuna risposta.");
    return sectionWrap("💪 Punti di forza e difficoltà", "", `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Cose in cui sono bravi</p>
          <p class="stats-caption">Clicca per vedere chi.</p>
          ${goodBody}
        </div>
        <div>
          <p class="stats-subtitle">Cose che trovano difficili</p>
          <p class="stats-caption">Clicca per vedere chi.</p>
          ${hardBody}
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
    const focusBody = barListHTML(sortedEntries(focusCounts.counts), { total: students.length, color: "var(--lilac)" });

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

  // ---------------------------------------------------------------------
  // VOTI (Teacher Registro) — statistiche reali sui voti, aggregate sul
  // gruppo di alunni passato (tutti, o una singola classe). Sola lettura:
  // i dati arrivano già scaricati in ctx.gradingBundle (vedi app.js loadData
  // e FirebaseService.fetchGradingData), il calcolo vero e proprio è in
  // grading-stats.js (window.GradingStats), condiviso con la scheda alunno.
  // ---------------------------------------------------------------------

  // Stessa soglia della legenda voti di Teacher Registro: sotto il 6 è
  // insufficiente (rosso), 6-6.9 sufficiente (oro), 7+ buono/ottimo (verde).
  function gradeColorForAvg(v) {
    if (v === null || v === undefined) return "rgba(35,40,59,0.25)";
    if (v >= 7) return "var(--mint-leaf)";
    if (v >= 6) return "var(--bright-gold)";
    return "var(--tiger-flame)";
  }

  function gradeColorForPct(pct) {
    return gradeColorForAvg(pct / 10);
  }

  function studentsWithClassId(students, ctx) {
    const byName = (ctx.gradingBundle && ctx.gradingBundle.classIdByName) || {};
    return students.map((s) => ({ fullName: s.fullName, classId: byName[ctx.getClassValue(s)] || null }));
  }

  function studentLabelFor(fullName, students, ctx) {
    const found = students.find((s) => s.fullName === fullName);
    return found ? ctx.studentDisplayName(found) : fullName;
  }

  function gradeMiniListHTML(items, students, ctx) {
    if (!items.length) return `<p class="stats-empty">—</p>`;
    return `<div class="grade-mini-list">${items.map((r) => `
      <div class="grade-mini-row">
        <span class="grade-mini-dot" style="background:${gradeColorForAvg(r.score)}"></span>
        <span class="grade-mini-title">${escHtml(r.title)} <em>(${escHtml(studentLabelFor(r.student, students, ctx))})</em></span>
        <span class="grade-mini-score">${fmt1(r.score)}</span>
      </div>`).join("")}</div>`;
  }

  function gradingBarRowHTML(label, value, max, valueText) {
    const pct = max > 0 ? Math.max(6, Math.round((value / max) * 100)) : 0;
    const color = max === 100 ? gradeColorForPct(value) : gradeColorForAvg(value);
    return `
      <div class="bar-row">
        <span class="bar-label">${escHtml(label)}</span>
        <div class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></div>
        <span class="bar-value">${escHtml(valueText)}</span>
      </div>`;
  }

  function rendimentoVotiSection(students, ctx) {
    if (!ctx.gradingBundle || !window.GradingStats) {
      return sectionWrap(
        "📊 Voti (Teacher Registro)", "",
        `<p class="stats-empty">Collega Classroom Manager per vedere qui le statistiche sui voti di Teacher Registro.</p>`
      );
    }

    const classIds = [...new Set(
      students.map((s) => (ctx.gradingBundle.classIdByName || {})[ctx.getClassValue(s)]).filter(Boolean)
    )];
    const testCount = window.GradingStats.countDistinctTests(ctx.gradingBundle.grading, classIds.length ? classIds : null);
    const group = window.GradingStats.computeGroupStats(studentsWithClassId(students, ctx), ctx.gradingBundle.grading);

    if (!group.testCount) {
      return sectionWrap(
        "📊 Voti (Teacher Registro)", "",
        `<p class="stats-empty">Nessun voto trovato in Teacher Registro per questi alunni.</p>`
      );
    }

    const kpis = `
      <div class="stats-kpis stats-kpis-inline" style="margin-bottom:16px;">
        <div class="stat-card">
          <div class="stat-value">${testCount}</div>
          <div class="stat-label">Verifiche svolte</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" style="color:${gradeColorForAvg(group.average)}">${fmt1(group.average)}</div>
          <div class="stat-label">Media generale</div>
        </div>
      </div>`;

    const competenciesHTML = group.competencies.length ? `
      <p class="stats-subtitle">Competenze</p>
      <div class="bar-list" style="margin-bottom:16px;">
        ${group.competencies.map((c) => gradingBarRowHTML(c.name, c.avg, 100, `${Math.round(c.avg)}%`)).join("")}
      </div>` : "";

    const categoriesHTML = group.categories.length ? `
      <p class="stats-subtitle">Categoria di verifica</p>
      <div class="bar-list" style="margin-bottom:16px;">
        ${group.categories.map((c) => gradingBarRowHTML(c.name, c.avg, 10, fmt1(c.avg))).join("")}
      </div>` : "";

    const periodsHTML = group.periods.length ? `
      <p class="stats-subtitle">Andamento per quadrimestre</p>
      <div class="bar-list" style="margin-bottom:16px;">
        ${group.periods.map((p) => gradingBarRowHTML(p.label, p.avg, 10, fmt1(p.avg))).join("")}
      </div>` : "";

    return sectionWrap(
      "📊 Voti (Teacher Registro)",
      "Statistiche calcolate dai voti reali inseriti in Teacher Registro (i voti ≤2, cioè assente/non svolto, non sono conteggiati).",
      `${kpis}${competenciesHTML}${categoriesHTML}${periodsHTML}
       <div class="stats-subgrid">
         <div><p class="stats-subtitle">🟢 Voti migliori</p>${gradeMiniListHTML(group.best, students, ctx)}</div>
         <div><p class="stats-subtitle">🔴 Voti da recuperare</p>${gradeMiniListHTML(group.worst, students, ctx)}</div>
       </div>`
    );
  }

  // Colore della barra media: stessa scala rosso→oro→verde dei bottoni voto
  // nella scheda Comportamento, così il colpo d'occhio resta coerente.
  function behaviorColorForAvg(v) {
    const stops = [[1, [229, 57, 53]], [5.5, [243, 212, 36]], [10, [88, 188, 152]]];
    let lo = stops[0]; let hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i += 1) {
      if (v >= stops[i][0] && v <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const t = (v - lo[0]) / (hi[0] - lo[0] || 1);
    const rgb = lo[1].map((c, idx) => Math.round(c + (hi[1][idx] - c) * t));
    return `rgb(${rgb.join(",")})`;
  }

  function behaviorSection(students, ctx) {
    const rated = ratingAverages((ctx.BEHAVIOR_TRAITS || []).map(([k, l]) => [k, l]), students);
    const withData = rated.filter((r) => r.n > 0);
    if (!withData.length) {
      return sectionWrap("🧭 Comportamento", "", `<p class="stats-empty">Non hai ancora valutato nessun alunno nella scheda "Comportamento".</p>`);
    }
    const body = `<div class="bar-list">${withData.map((r) => `
      <div class="bar-row">
        <span class="bar-label">${escHtml(r.label)}</span>
        <div class="bar-track"><span class="bar-fill" style="width:${Math.max(6, Math.round((r.avg / 10) * 100))}%;background:${behaviorColorForAvg(r.avg)}"></span></div>
        <span class="bar-value">${fmt1(r.avg)}/10 <span class="rate-n">· n=${r.n}</span></span>
      </div>`).join("")}</div>`;
    return sectionWrap("🧭 Comportamento", "Valutazioni date da te nella scheda \u201cComportamento\u201d di ciascun alunno.", body);
  }

  function standardSections(students, ctx) {
    return originSection(students, ctx)
      + subjectsSection(students, ctx)
      + lessonsSection(students, ctx)
      + hobbiesSection(students, ctx)
      + strengthsSection(students, ctx)
      + englishSection(students, ctx)
      + habitsSection(students, ctx)
      + rendimentoSection(students, ctx)
      + rendimentoVotiSection(students, ctx)
      + behaviorSection(students, ctx);
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
    const behRated = ratingAverages((ctx.BEHAVIOR_TRAITS || []).map(([k, l]) => [k, l]), students).filter((r) => r.n > 0);
    const behAvg = behRated.length ? behRated.reduce((a, r) => a + r.avg, 0) / behRated.length : null;
    const withNationality = students.filter((s) => (s.nationality || "").trim());
    const nonItalianN = withNationality.filter((s) => !isItalian(s.nationality)).length;

    let gradesRow = "";
    if (ctx.gradingBundle && window.GradingStats) {
      const classId = (ctx.gradingBundle.classIdByName || {})[String(cls).trim().toUpperCase()] || null;
      const group = window.GradingStats.computeGroupStats(
        students.map((s) => ({ fullName: s.fullName, classId })),
        ctx.gradingBundle.grading
      );
      if (group.testCount) {
        gradesRow = `<div><dt>Media voti</dt><dd style="color:${gradeColorForAvg(group.average)}">${fmt1(group.average)}</dd></div>`;
      }
    }

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
          ${gradesRow}
          <div><dt>Comportamento medio</dt><dd>${behAvg != null ? `${fmt1(behAvg)}/10` : "—"}</dd></div>
          <div><dt>Non italiani</dt><dd>${nonItalianN}/${n}</dd></div>
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
    container.querySelectorAll("[data-hobby-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.hobbyKind;
        const list = lastHobbyClusters[kind] || [];
        const cluster = list[parseInt(btn.dataset.hobbyIndex, 10)];
        if (cluster && ctx.onHobbyClick) ctx.onHobbyClick(cluster.label, cluster.studentIds, kind);
      });
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