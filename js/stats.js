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

  // Campi che sappiamo già trattare esplicitamente altrove nella pagina:
  // servono per capire quali altri campi del questionario sono "extra"
  // (es. un eventuale "figlio unico" aggiunto in futuro al questionario)
  // e proporli automaticamente, senza doverli conoscere in anticipo.
  const BASE_KNOWN_FIELDS = [
    "id", "isTestProfile", "className", "class", "classe",
    "firstName", "lastName", "fullName", "displayName",
    "photoUrl", "preferredName", "teacherNotes", "events", "linkedResponseId", "lastEditedAt",
    "favoriteSubject", "favoriteSubjectReason",
    "englishFocus", "englishGoal", "englishWorry", "englishConfidence", "englishYears",
    "livesWith", "languagesHome", "studyPlace", "studyHelper", "studyOther",
    "screenTime", "homeworkStart", "bedTime", "wakeTime", "sleepHours",
    "hobbySummary", "weekendLove",
    "goodAt1", "goodAt2", "goodAt3", "difficult1", "difficult2", "difficult3",
    "bestLessons",
    "noteHomeLife", "noteStudyHabits", "noteSleepScreen",
    "noteHobbiesMain", "noteHobbiesGood", "noteHobbiesHard", "noteEnglishIntro",
    "nationality", "yearsInItaly", "italianLevel"
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
  let lastHobbyClusters = {}; // { hobbies: [...], goodAt: [...], difficult: [...] }, per il click sulle nuvole

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
  // CAMPI EXTRA AUTO-RILEVATI (es. "figlio unico" se presente nel questionario)
  // ---------------------------------------------------------------------
  // Campi che riguardano genitori/parenti/fratelli/contatti: nomi di persone
  // non sono statistiche utili, quindi qualsiasi campo il cui nome li richiami
  // viene escluso automaticamente dai "dati extra", a prescindere dal nome
  // esatto usato nel questionario (in italiano o inglese). Include anche i
  // campi hobby "grezzi" (hobbyName1, hobbyRating2, ...): i nomi sono già
  // raccolti e ripuliti nella nuvola hobby dedicata, i voti singoli per slot
  // non hanno un significato aggregato chiaro da soli.
  const EXCLUDED_EXTRA_FIELD_PATTERN = /parent|mother|father|guardian|genitor|padre|madre|famigli|famili|relative|contact|emergenc|sister|brother|sibling|sorell|fratell|^hobbyname\d*$|^hobbyrating\d*$/i;

  function buildExcludeSet(ctx) {
    const known = new Set(BASE_KNOWN_FIELDS);
    (ctx.SUBJECTS || []).forEach(([k]) => { known.add(k); known.add(`${k}Comment`); });
    (ctx.LESSON_STYLES || []).forEach(([k]) => { known.add(k); known.add(`${k}Comment`); });
    (ctx.PERF_SKILLS || []).forEach(([k]) => { known.add(k); known.add(`${k}Note`); });
    (ctx.BEHAVIOR_TRAITS || []).forEach(([k]) => { known.add(k); known.add(`${k}Note`); });
    return known;
  }

  function detectExtraFields(students, ctx) {
    const known = buildExcludeSet(ctx);
    const valuesByKey = new Map();
    students.forEach((s) => {
      Object.keys(s).forEach((key) => {
        if (known.has(key)) return;
        if (EXCLUDED_EXTRA_FIELD_PATTERN.test(key)) return;
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
    const natBody = barListHTML(sortedEntries(natCounts.counts), { total: natCounts.n, color: "var(--sky-blue)" });

    const years = numericSummary(nonItalian, "yearsInItaly");
    const yearsBody = years
      ? `<p class="stats-insight">In media sono in Italia da <strong>${fmt1(years.avg)} anni</strong> (n=${years.n}).</p>`
      : `<p class="stats-empty">Dati sugli anni in Italia non ancora disponibili.</p>`;

    const levelCounts = countBy(nonItalian, (s) => ctx.optionLabel(ctx.ITALIAN_LEVEL_OPTIONS, s.italianLevel, ""));
    const levelBody = barListHTML(sortedEntries(levelCounts.counts), { total: levelCounts.n, color: "var(--mint-leaf)" });

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
    const placeBody = barListHTML(placeItems, { total: placeCounts.n, color: "var(--sky-blue)" });
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
    return originSection(students, ctx)
      + subjectsSection(students, ctx)
      + lessonsSection(students, ctx)
      + hobbiesSection(students, ctx)
      + strengthsSection(students, ctx)
      + englishSection(students, ctx)
      + habitsSection(students, ctx)
      + rendimentoSection(students, ctx)
      + behaviorSection(students, ctx)
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
    const behRated = ratingAverages((ctx.BEHAVIOR_TRAITS || []).map(([k, l]) => [k, l]), students).filter((r) => r.n > 0);
    const behAvg = behRated.length ? behRated.reduce((a, r) => a + r.avg, 0) / behRated.length : null;
    const withNationality = students.filter((s) => (s.nationality || "").trim());
    const nonItalianN = withNationality.filter((s) => !isItalian(s.nationality)).length;

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
          <div><dt>Comportamento medio</dt><dd>${behAvg != null ? `${fmt1(behAvg)}/10` : "—"}</dd></div>
          <div><dt>Non italiani</dt><dd>${withNationality.length ? `${nonItalianN}/${withNationality.length}` : "—"}</dd></div>
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