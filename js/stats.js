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
  let selectedClass = null; // null = tutte le classi (pallini tutti accesi)
  let activeGroup = "anagrafica"; // gruppo dell'indice: vedi STATS_GROUPS
  let selectedTestId = null; // verifica mostrata nella distribuzione voti
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
    // Il questionario li salva come hobbyName_1, hobbyName_2, ...
    const hobbyKeys = new Set(["hobbySummary"]);
    students.forEach((s) => {
      Object.keys(s).forEach((k) => { if (/^hobbyName_?\d*$/i.test(k)) hobbyKeys.add(k); });
    });
    const body = tagCloudHTML(students, [...hobbyKeys], ctx, "hobbies", "Ancora nessuna risposta sugli hobby.");
    const weekendBody = tagCloudHTML(students, ["weekendLove"], ctx, "weekend", "Ancora nessuna risposta.");
    return sectionWrap("🎨 Hobby e cosa gli piace", "", `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Hobby più menzionati</p>
          <p class="stats-caption">Stima dalle risposte libere; le varianti molto simili (es. "video games" e "videogames") vengono raggruppate. Clicca su un hobby per vedere chi lo pratica.</p>
          ${body}
        </div>
        <div>
          <p class="stats-subtitle">Cosa amano fare nel weekend</p>
          <p class="stats-caption">Clicca per vedere chi.</p>
          ${weekendBody}
        </div>
      </div>`);
  }

  // --- "Chi ti aiuta a studiare?" (risposta libera) ----------------------
  // Le risposte dei bambini sono in inglese/italiano e con molte varianti
  // ("No one", "nobody", "I study alone"; "Mom", "Mother", "My mother"):
  // le riconduco a poche etichette. Una risposta con più persone ("mom and
  // dad") conta per ciascuna, ma ogni alunno conta una sola volta per etichetta.
  const STUDY_HELPER_SYNONYMS = [
    ["Nessuno (da solo)", ["no one", "noone", "nobody", "none", "no", "nothing", "alone", "i study alone", "study alone", "i do it alone",
      "myself", "me", "by myself", "on my own", "just me", "only me", "i", "nessuno", "da solo", "da sola", "io", "solo", "sola", "studio da solo", "studio da sola"]],
    ["Mamma", ["mom", "mum", "mother", "mommy", "mummy", "mama", "mamma", "mamy", "madre", "mami"]],
    ["Papà", ["dad", "daddy", "father", "papa", "papà", "padre", "babbo"]],
    ["Genitori", ["parents", "genitori"]],
    ["Fratelli", ["brother", "brothers", "fratello", "fratelli"]],
    ["Sorelle", ["sister", "sisters", "sorella", "sorelle"]],
    ["Nonni", ["grandma", "grandmother", "granny", "grandpa", "grandfather", "grandparents", "nonna", "nonno", "nonni"]],
    ["Zii", ["aunt", "auntie", "uncle", "zia", "zio", "zii"]],
    ["Cugini", ["cousin", "cousins", "cugino", "cugina", "cugini"]],
    ["Insegnante / tutor", ["teacher", "tutor", "insegnante", "maestra", "maestro", "doposcuola", "after school"]],
    ["Amici", ["friend", "friends", "amico", "amica", "amici"]]
  ];
  const STUDY_HELPER_MAP = new Map();
  STUDY_HELPER_SYNONYMS.forEach(([label, words]) => words.forEach((w) => STUDY_HELPER_MAP.set(w, label)));

  function studyHelperLabels(raw) {
    const text = String(raw || "").toLowerCase().trim();
    if (!text) return [];
    const whole = STUDY_HELPER_MAP.get(text.replace(/[^\p{L}\s]/gu, "").replace(/\s+/g, " ").trim());
    if (whole) return [whole];
    const labels = new Set();
    text.split(/[,;/&+\n]|\s+and\s+|\s+e\s+|\s+or\s+|\s+o\s+/).forEach((chunk) => {
      const cleaned = chunk
        .replace(/[^\p{L}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^(sometimes|usually|often|a volte|di solito)\s+/, "")
        .replace(/^(my|la mia|il mio|i miei|le mie|mia|mio|miei|mie|la|il)\s+/, "")
        .replace(/\s+(helps me|help me|mi aiuta|mi aiutano)$/, "")
        .trim();
      if (!cleaned) return;
      labels.add(STUDY_HELPER_MAP.get(cleaned) || cleaned.charAt(0).toUpperCase() + cleaned.slice(1));
    });
    return [...labels];
  }

  function studyPlaceSection(students, ctx) {
    const placeCounts = countBy(students, (s) => ctx.optionLabel(ctx.STUDY_PLACE_OPTIONS, s.studyPlace, ""));
    const placeBody = barListHTML(sortedEntries(placeCounts.counts), { total: students.length, color: "var(--sky-blue)" });
    const helperCounts = new Map();
    let helperN = 0;
    students.forEach((s) => {
      const raw = ctx.flattenValue ? ctx.flattenValue(s.studyHelper) : s.studyHelper || "";
      const labels = studyHelperLabels(raw);
      if (!labels.length) return;
      helperN += 1;
      labels.forEach((l) => helperCounts.set(l, (helperCounts.get(l) || 0) + 1));
    });
    const helperBody = barListHTML(sortedEntries(helperCounts).slice(0, 8), { total: helperN, color: "var(--lilac)" });
    return sectionWrap("🏠 Studio a casa", "", `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Dove studiano di solito</p>
          ${placeBody}
        </div>
        <div>
          <p class="stats-subtitle">Chi li aiuta a studiare</p>
          ${helperBody}
        </div>
      </div>`);
  }

  // --- Famiglia: "Who lives with you?" del questionario -------------------
  // livesWith è la lista separata da virgole delle caselle spuntate
  // (Mother, Father, Brother, Sister, ...); brotherCount/sisterCount hanno
  // senso solo se la casella corrispondente è spuntata (altrimenti il
  // questionario invia comunque il valore di default 1).
  const FAMILY_LABELS = {
    mother: "Mamma", father: "Papà", brother: "Fratelli", sister: "Sorelle",
    grandmother: "Nonna", grandfather: "Nonno", auntuncle: "Zii",
    cousin: "Cugini", friend: "Amici", other: "Altri"
  };

  function splitList(raw) {
    return String(raw || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  }

  function livesWithList(s) {
    return splitList(s.livesWith).map((x) => x.toLowerCase().replace(/[^a-z]/g, ""));
  }

  function siblingsCount(s) {
    const list = livesWithList(s);
    if (!list.length) return null;
    const n = (key, countKey) => (list.includes(key) ? Math.max(1, parseInt(s[countKey], 10) || 1) : 0);
    return n("brother", "brotherCount") + n("sister", "sisterCount");
  }

  function familySection(students) {
    const withData = students.filter((s) => livesWithList(s).length);
    if (!withData.length) {
      return sectionWrap("👨‍👩‍👧 Famiglia", "", `<p class="stats-empty">Ancora nessuna risposta su chi vive in casa.</p>`);
    }
    const livesCounts = new Map();
    withData.forEach((s) => {
      new Set(livesWithList(s)).forEach((k) => {
        const label = FAMILY_LABELS[k] || k;
        livesCounts.set(label, (livesCounts.get(label) || 0) + 1);
      });
    });
    const sibCounts = countBy(withData, (s) => {
      const n = siblingsCount(s);
      if (n === null) return "";
      return n === 0 ? "Nessuno" : n >= 3 ? "3 o più" : String(n);
    });
    const sibOrder = ["Nessuno", "1", "2", "3 o più"];
    const sibItems = sortedEntries(sibCounts.counts).sort((a, b) => sibOrder.indexOf(a[0]) - sibOrder.indexOf(b[0]));
    const sibValues = withData.map(siblingsCount).filter((n) => n !== null);
    const sibAvg = sibValues.length ? sibValues.reduce((a, b) => a + b, 0) / sibValues.length : 0;
    const only = sibValues.filter((n) => n === 0).length;
    const insight = `In media <strong>${fmt1(sibAvg)}</strong> fratelli/sorelle in casa; ${only} alunn${only === 1 ? "o" : "i"} su ${sibValues.length} senza fratelli conviventi.`;

    return sectionWrap("👨‍👩‍👧 Famiglia", insight, `
      <div class="stats-subgrid">
        <div>
          <p class="stats-subtitle">Con chi vivono</p>
          ${barListHTML(sortedEntries(livesCounts), { total: withData.length, color: "var(--bright-gold)" })}
        </div>
        <div>
          <p class="stats-subtitle">Quanti fratelli e sorelle (in casa)</p>
          ${barListHTML(sibItems, { total: withData.length, color: "var(--lilac)" })}
        </div>
      </div>`);
  }

  // --- Lingue parlate a casa: languagesHome = "Italian, Arabic, ..." ------
  const LANGUAGE_LABELS = {
    italian: "Italiano", english: "Inglese", albanian: "Albanese", arabic: "Arabo",
    chinese: "Cinese", romanian: "Rumeno", spanish: "Spagnolo", ukrainian: "Ucraino",
    french: "Francese", german: "Tedesco", russian: "Russo", portuguese: "Portoghese"
  };

  function languageLabel(raw) {
    const key = raw.trim().toLowerCase();
    if (LANGUAGE_LABELS[key]) return LANGUAGE_LABELS[key];
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  function languagesSection(students) {
    const withData = students.filter((s) => splitList(s.languagesHome).length);
    if (!withData.length) {
      return sectionWrap("🗣️ Lingue parlate a casa", "", `<p class="stats-empty">Ancora nessuna risposta sulle lingue parlate a casa.</p>`);
    }
    const langCounts = new Map();
    let multilingual = 0;
    let noItalian = 0;
    withData.forEach((s) => {
      const langs = [...new Set(splitList(s.languagesHome).map(languageLabel))];
      if (langs.length > 1) multilingual += 1;
      if (!langs.includes("Italiano")) noItalian += 1;
      langs.forEach((l) => langCounts.set(l, (langCounts.get(l) || 0) + 1));
    });
    const insight = `${multilingual} alunn${multilingual === 1 ? "o parla" : "i parlano"} più di una lingua a casa`
      + (noItalian ? `; ${noItalian} non parla${noItalian === 1 ? "" : "no"} italiano a casa.` : ".");
    return sectionWrap("🗣️ Lingue parlate a casa", insight,
      barListHTML(sortedEntries(langCounts), { total: withData.length, color: "var(--sky-blue)" }));
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

  // ---------------------------------------------------------------------
  // DISTRIBUZIONE VOTI PER VERIFICA: istogramma + curva gaussiana
  // (media e deviazione standard dei voti degli alunni selezionati).
  // ---------------------------------------------------------------------
  function testDateFor(test, classIds) {
    const dates = Object.entries(test.classDates || {})
      .filter(([id]) => !classIds.length || classIds.includes(String(id)))
      .map(([, d]) => d)
      .filter(Boolean)
      .sort();
    return dates[0] || "";
  }

  function scoresByTest(students, ctx) {
    const byTest = new Map(); // testId -> [score, ...]
    studentsWithClassId(students, ctx).forEach(({ fullName, classId }) => {
      const { results } = window.GradingStats.computeStudentResults(fullName, classId, ctx.gradingBundle.grading);
      results.forEach((r) => {
        if (!byTest.has(r.id)) byTest.set(r.id, []);
        byTest.get(r.id).push(r.score);
      });
    });
    return byTest;
  }

  function gaussianSVG(scores) {
    const W = 600; const H = 230;
    const padL = 34; const padR = 14; const padT = 14; const padB = 32;
    const plotW = W - padL - padR; const plotH = H - padT - padB;
    const xMin = 2; const xMax = 10.5;
    const x = (v) => padL + ((v - xMin) / (xMax - xMin)) * plotW;

    // Un "secchio" per ogni voto intero (3, 4, ... 10), arrotondando.
    const bins = [];
    for (let g = 3; g <= 10; g += 1) bins.push({ g, n: 0 });
    scores.forEach((s) => {
      const g = Math.min(10, Math.max(3, Math.round(s)));
      bins[g - 3].n += 1;
    });

    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const pdf = (v) => (sd > 0 ? Math.exp(-0.5 * ((v - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI)) : 0);
    // La curva è scalata sui conteggi (n alunni × ampiezza secchio = 1 voto).
    const peakCurve = sd > 0 ? n * pdf(mean) : 0;
    const yMax = Math.max(1, ...bins.map((b) => b.n), peakCurve) * 1.1;
    const y = (c) => padT + plotH - (c / yMax) * plotH;

    const barW = (plotW / (xMax - xMin)) * 0.7;
    const bars = bins.map((b) => b.n ? `
      <rect x="${(x(b.g) - barW / 2).toFixed(1)}" y="${y(b.n).toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + plotH - y(b.n)).toFixed(1)}" rx="4" style="fill:${gradeColorForAvg(b.g)};opacity:0.8"><title>Voto ${b.g}: ${b.n} alunn${b.n === 1 ? "o" : "i"}</title></rect>
      <text x="${x(b.g).toFixed(1)}" y="${(y(b.n) - 4).toFixed(1)}" text-anchor="middle" font-size="11" style="fill:var(--space-indigo)">${b.n}</text>` : "").join("");

    let curve = "";
    if (sd > 0) {
      const pts = [];
      for (let v = xMin; v <= xMax + 0.001; v += 0.05) pts.push(`${x(v).toFixed(1)},${y(n * pdf(v)).toFixed(1)}`);
      curve = `<polyline points="${pts.join(" ")}" fill="none" stroke-width="2.5" style="stroke:var(--space-indigo)" />`;
    }

    const axis = bins.map((b) => `<text x="${x(b.g).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="12" style="fill:var(--space-indigo)">${b.g}</text>`).join("");
    const meanLine = `
      <line x1="${x(mean).toFixed(1)}" x2="${x(mean).toFixed(1)}" y1="${padT}" y2="${padT + plotH}" stroke-dasharray="4 4" stroke-width="1.5" style="stroke:var(--tiger-flame)" />
      <text x="${x(mean).toFixed(1)}" y="${padT + 10}" dx="4" font-size="11" style="fill:var(--tiger-flame)">media ${fmt1(mean)}</text>`;
    const sufficiency = `<line x1="${x(5.5).toFixed(1)}" x2="${x(5.5).toFixed(1)}" y1="${padT}" y2="${padT + plotH}" stroke-width="1" style="stroke:rgba(35,40,59,0.2)" />`;

    const svg = `
      <svg class="gaussian-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribuzione dei voti: media ${fmt1(mean)}, deviazione standard ${fmt1(sd)}">
        <line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" stroke-width="1" style="stroke:rgba(35,40,59,0.3)" />
        ${sufficiency}${bars}${curve}${meanLine}${axis}
      </svg>`;

    const sufficient = scores.filter((s) => s >= 6).length;
    const stats = `
      <div class="dist-stats-row">
        <span>Alunni: <strong>${n}</strong></span>
        <span>Media: <strong>${fmt1(mean)}</strong></span>
        <span>Dev. standard: <strong>${fmt1(sd)}</strong></span>
        <span>Min–max: <strong>${fmt1(Math.min(...scores))}–${fmt1(Math.max(...scores))}</strong></span>
        <span>Sufficienti: <strong>${Math.round((sufficient / n) * 100)}%</strong></span>
      </div>`;
    return svg + stats;
  }

  function distribuzioneVotiSection(students, ctx) {
    if (!ctx.gradingBundle || !window.GradingStats) return "";
    const byName = ctx.gradingBundle.classIdByName || {};
    const classIds = [...new Set(students.map((s) => byName[ctx.getClassValue(s)]).filter(Boolean))];
    const byTest = scoresByTest(students, ctx);

    const tests = window.GradingStats.activeTests(ctx.gradingBundle.grading)
      .filter((t) => t && t.id && byTest.has(t.id))
      .map((t) => ({ id: t.id, title: t.title || "Verifica", date: testDateFor(t, classIds) }))
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));

    if (!tests.length) {
      return sectionWrap("📈 Distribuzione voti per verifica", "", `<p class="stats-empty">Nessuna verifica attiva con voti per questi alunni.</p>`);
    }

    if (!tests.some((t) => t.id === selectedTestId)) selectedTestId = tests[tests.length - 1].id; // la più recente
    const options = tests.map((t) => {
      const d = t.date ? ` · ${new Date(t.date).toLocaleDateString("it-IT", { day: "numeric", month: "short" })}` : "";
      const avg = byTest.get(t.id).reduce((a, b) => a + b, 0) / byTest.get(t.id).length;
      return `<option value="${escAttr(t.id)}"${t.id === selectedTestId ? " selected" : ""}>${escHtml(t.title)}${d} — media ${fmt1(avg)}</option>`;
    }).join("");

    return sectionWrap(
      "📈 Distribuzione voti per verifica",
      "Istogramma dei voti e curva gaussiana (media e deviazione standard) della verifica scelta. Solo verifiche attive in Teacher Registro.",
      `<div class="dist-controls">
         <select class="dist-select" data-dist-test aria-label="Scegli la verifica">${options}</select>
       </div>
       ${gaussianSVG(byTest.get(selectedTestId))}`
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

  // ---------------------------------------------------------------------
  // INDICE: le sezioni sono divise in gruppi, se ne mostra uno alla volta
  // ---------------------------------------------------------------------
  const STATS_GROUPS = [
    {
      id: "anagrafica",
      label: "🪪 Anagrafica",
      hint: "Dati degli alunni dal questionario Student ID.",
      sections: [originSection, familySection, languagesSection, hobbiesSection, strengthsSection, habitsSection]
    },
    {
      id: "scuola",
      label: "📚 Materie e scuola",
      hint: "Materie e lezioni che piacciono, inglese e studio.",
      sections: [subjectsSection, lessonsSection, englishSection, studyPlaceSection]
    },
    {
      id: "verifiche",
      label: "📊 Verifiche",
      hint: "Voti reali delle verifiche attive in Teacher Registro.",
      sections: [rendimentoVotiSection, distribuzioneVotiSection]
    },
    {
      id: "valutazioni",
      label: "🧑‍🏫 Le tue valutazioni",
      hint: "Rendimento e comportamento valutati da te nelle schede.",
      sections: [rendimentoSection, behaviorSection]
    }
  ];

  function currentGroup() {
    return STATS_GROUPS.find((g) => g.id === activeGroup) || STATS_GROUPS[0];
  }

  function statsIndexHTML() {
    const group = currentGroup();
    return `
      <nav class="stats-index" aria-label="Indice statistiche">
        ${STATS_GROUPS.map((g) => `<button type="button" class="stats-index-btn${g.id === group.id ? " is-selected" : ""}" data-stats-group="${g.id}">${g.label}</button>`).join("")}
      </nav>
      <p class="stats-index-hint">${escHtml(group.hint)}</p>`;
  }

  function standardSections(students, ctx) {
    return currentGroup().sections.map((fn) => fn(students, ctx)).join("");
  }

  // ---------------------------------------------------------------------
  // COSTRUZIONE PAGINA
  // ---------------------------------------------------------------------
  // Pallini delle classi: di default sono tutte selezionate (selectedClass
  // = null); un clic su una classe mostra solo quella, un secondo clic
  // sulla stessa (o su "Tutte") torna a tutte le classi.
  function classDotsHTML(realStudents, ctx) {
    const allSelected = !selectedClass;
    const dots = ctx.CLASS_LIST.map((c) => {
      const n = realStudents.filter((s) => ctx.getClassValue(s) === c).length;
      const on = allSelected || selectedClass === c;
      return `<button type="button" class="class-dot${on ? " is-selected" : ""}" data-pick-class="${escAttr(c)}" style="--chip-color:${ctx.classColor(c)}" title="${escAttr(c)} · ${n} alunn${n === 1 ? "o" : "i"}" aria-pressed="${selectedClass === c}">${escHtml(c)}</button>`;
    }).join("");
    return `
      <div class="class-dots" role="group" aria-label="Filtra per classe">
        <button type="button" class="class-dot class-dot-all${allSelected ? " is-selected" : ""}" data-pick-class="" aria-pressed="${allSelected}">Tutte</button>
        ${dots}
      </div>`;
  }

  function heroHTML(realStudents, shown, ctx) {
    const classesActive = new Set(shown.map((s) => ctx.getClassValue(s)).filter(Boolean)).size;
    return `
      <div class="stats-hero">
        <div class="stats-kpis">
          <div class="stat-card">
            <div class="stat-value">${shown.length}</div>
            <div class="stat-label">Alunni monitorati</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${classesActive}</div>
            <div class="stat-label">Classi con dati</div>
          </div>
        </div>
        ${classDotsHTML(realStudents, ctx)}
        ${statsIndexHTML()}
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

    if (selectedClass && !ctx.CLASS_LIST.includes(selectedClass)) selectedClass = null;
    const shown = selectedClass ? realStudents.filter((s) => ctx.getClassValue(s) === selectedClass) : realStudents;

    const heading = selectedClass
      ? `<p class="stats-class-heading">Classe ${escHtml(selectedClass)} — ${shown.length} alunn${shown.length === 1 ? "o" : "i"}</p>`
      : "";
    const body = shown.length
      ? standardSections(shown, ctx)
      : `<div class="stats-section"><p class="stats-empty">Nessun alunno in questa classe.</p></div>`;

    return heroHTML(realStudents, shown, ctx) + `<div class="stats-body">${heading}${body}</div>`;
  }

  // ---------------------------------------------------------------------
  // EVENTI
  // ---------------------------------------------------------------------
  function wireEvents(container, ctx) {
    container.querySelectorAll("[data-stats-group]").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeGroup = btn.dataset.statsGroup;
        rerender();
      });
    });
    container.querySelectorAll("[data-pick-class]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cls = btn.dataset.pickClass || null;
        selectedClass = cls && selectedClass !== cls ? cls : null;
        rerender();
      });
    });
    container.querySelectorAll("[data-dist-test]").forEach((sel) => {
      sel.addEventListener("change", () => {
        selectedTestId = sel.value;
        rerender();
      });
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
