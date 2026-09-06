(function () {
  "use strict";

  // =====================================================================
  //  GradingStats — statistiche sui voti (Teacher Registro) per la scheda
  //  del singolo alunno in Panoramica Prof.
  //
  //  Modulo di SOLA LETTURA: non scrive mai nulla su Firebase. Replica
  //  fedelmente il calcolo dei voti di Teacher Registro (getFinalScore /
  //  getSectionScore / pesi e versioni) leggendo i dati già scaricati da
  //  FirebaseService.fetchGradingData() (classroomanager → users/{uid}/grading).
  //
  //  Espone una sola funzione pubblica: computeStudentStats(fullName, classId,
  //  gradingData). Il rendering HTML resta in app.js, come per le altre schede.
  // =====================================================================

  function parseNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }

  function getSubsectionWeight(sub) {
    return parseNumber(sub && sub.weight) ?? 1;
  }

  function getSubsectionMax(section, sub, fallbackPerSub) {
    const explicit = parseNumber(sub && sub.max);
    if (explicit != null) return explicit;
    if (fallbackPerSub != null) return fallbackPerSub;
    const fallbackMax = parseNumber(section && section.max) ?? 0;
    const count = (section && section.subsections && section.subsections.length) || 0;
    return count > 0 ? fallbackMax / count : 0;
  }

  function getSectionTotals(section) {
    const subs = (section && section.subsections) || [];
    const fallbackMax = parseNumber(section && section.max) ?? 0;
    const fallbackPerSub = subs.length > 0 ? fallbackMax / subs.length : 0;
    return subs.reduce(
      (totals, sub) => {
        totals.totalWeight += getSubsectionWeight(sub);
        totals.totalMax += getSubsectionMax(section, sub, fallbackPerSub);
        return totals;
      },
      { totalWeight: 0, totalMax: 0 }
    );
  }

  function getSectionWeight(section) {
    if (section && section.subsections && section.subsections.length) {
      return getSectionTotals(section).totalWeight;
    }
    return parseNumber(section && section.weight) ?? 1;
  }

  function getSectionMax(section) {
    if (section && section.subsections && section.subsections.length) {
      return getSectionTotals(section).totalMax;
    }
    return parseNumber(section && section.max) ?? null;
  }

  // Punteggio di una sezione per lo studente in una verifica, SENZA mai
  // creare/modificare lo store dei voti (a differenza dell'originale in
  // Teacher Registro, pensato per la scrittura).
  function getSectionScore(studentScores, testId, section) {
    const sectionScores = studentScores && studentScores[testId] && studentScores[testId][section.id];
    const subsections = Array.isArray(section.subsections) ? section.subsections : [];
    if (subsections.length > 0) {
      const totals = getSectionTotals(section);
      if (totals.totalWeight <= 0 || totals.totalMax <= 0) return 0;
      const fallbackPerSub = totals.totalMax / subsections.length;
      const weightedRatioSum = subsections.reduce((sum, sub) => {
        const value = parseNumber(sectionScores && sectionScores.subsections && sectionScores.subsections[sub.id]) ?? 0;
        const max = getSubsectionMax(section, sub, fallbackPerSub);
        const weight = getSubsectionWeight(sub);
        if (max <= 0 || weight <= 0) return sum;
        return sum + (value / max) * weight;
      }, 0);
      return (weightedRatioSum / totals.totalWeight) * totals.totalMax;
    }
    return parseNumber(sectionScores && sectionScores.direct) ?? 0;
  }

  // True se l'alunno ha almeno un voto inserito in questa sezione, per
  // questa verifica — usata per non contare sezioni mai valutate.
  function hasAnySectionScore(studentScores, testId, section) {
    const sectionScores = studentScores && studentScores[testId] && studentScores[testId][section.id];
    if (!sectionScores) return false;
    const subsections = Array.isArray(section.subsections) ? section.subsections : [];
    if (subsections.length > 0) {
      return subsections.some((sub) => parseNumber(sectionScores.subsections && sectionScores.subsections[sub.id]) != null);
    }
    return parseNumber(sectionScores.direct) != null;
  }

  function hasAnyScore(studentScores, testId, sections) {
    return (sections || []).some((section) => hasAnySectionScore(studentScores, testId, section));
  }

  function getVersionById(test, versionId) {
    if (!test || !versionId) return null;
    return (test.versions || []).find((v) => v.id === versionId) || null;
  }

  function getDefaultVersion(test) {
    return (test && test.versions && test.versions[0]) || null;
  }

  function getFacilitatedVersionId(test) {
    if (!test) return null;
    if (test.facilitatedVersionId) return test.facilitatedVersionId;
    const versions = test.versions || [];
    return (versions[1] && versions[1].id) || (versions[0] && versions[0].id) || null;
  }

  function pickVersionForStudent(test, isFacilitated, studentVersionsForTests) {
    if (isFacilitated) {
      return getVersionById(test, getFacilitatedVersionId(test)) || getDefaultVersion(test);
    }
    const chosenId = (studentVersionsForTests && studentVersionsForTests[test.id]) || (getDefaultVersion(test) || {}).id;
    return getVersionById(test, chosenId) || getDefaultVersion(test);
  }

  function getFinalScore(studentScores, test, version) {
    if (!test || !version) return null;
    const sections = version.sections || [];
    let weightedSum = 0;
    let weightedMaxSum = 0;
    sections.forEach((section) => {
      const score = getSectionScore(studentScores, test.id, section);
      const weight = getSectionWeight(section) || 0;
      const max = getSectionMax(section) || 0;
      if (weight > 0 && max > 0) {
        weightedSum += score * weight;
        weightedMaxSum += max * weight;
      }
    });
    if (weightedMaxSum === 0) return null;
    return (weightedSum * 10) / weightedMaxSum;
  }

  // ---- Periodi dell'anno (quadrimestri) ---------------------------------
  // Anno scolastico italiano: Settembre–Gennaio = 1° Quadrimestre,
  // Febbraio–Agosto = 2° Quadrimestre. Nessuna verifica → nessun periodo.
  const QUADRIMESTRE_LABELS = ["1° Quadrimestre", "2° Quadrimestre"];

  function quadrimestreForDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    const month = d.getMonth() + 1; // 1-12
    return (month >= 9 || month === 1) ? QUADRIMESTRE_LABELS[0] : QUADRIMESTRE_LABELS[1];
  }

  function toArray(maybeObj) {
    if (Array.isArray(maybeObj)) return maybeObj;
    if (maybeObj && typeof maybeObj === "object") return Object.values(maybeObj);
    return [];
  }

  const EMPTY_STATS = {
    testCount: 0,
    average: null,
    competencies: [],
    categories: [],
    periods: [],
    best: [],
    worst: []
  };

  /**
   * Estrae i risultati "grezzi" (un elemento per verifica valutata) e i
   * punti "competenza" (un elemento per sezione valutata) di UN alunno,
   * senza ancora aggregarli — così lo stesso identico calcolo per-verifica
   * può alimentare sia la scheda del singolo alunno sia le statistiche di
   * gruppo/classe (basta unire gli array di più alunni prima di chiamare
   * aggregateResults()).
   *
   * @param {string} fullName
   * @param {string|null} classId
   * @param {object} gradingData
   * @returns {{ results: Array, competencyPoints: Array }}
   */
  function computeStudentResults(fullName, classId, gradingData) {
    const empty = { results: [], competencyPoints: [] };
    if (!gradingData || !fullName) return empty;

    const studentScores = (gradingData.scores || {})[fullName];
    if (!studentScores) return empty;

    const isFacilitated = (gradingData.facilitated || {})[fullName] === true;
    const studentVersions = (gradingData.testVersions || {})[fullName] || {};

    const allTests = [...toArray(gradingData.tests), ...toArray(gradingData.archivedTests)].filter(Boolean);

    const results = []; // { id, title, subject, category, date, score, student }
    const competencyPoints = []; // { name, pct }

    allTests.forEach((test) => {
      if (!test || !test.id) return;
      const version = pickVersionForStudent(test, isFacilitated, studentVersions);
      if (!version) return;
      if (!hasAnyScore(studentScores, test.id, version.sections)) return; // niente voto per questo alunno

      const score = getFinalScore(studentScores, test, version);
      // Un voto <= 2 indica "assente/non svolto" nella convenzione già usata
      // altrove nella suite (vedi computeStudentAverage in Teacher Registro):
      // non è un voto reale, va escluso da medie e classifiche.
      if (score === null || score <= 2) return;

      const category = (Array.isArray(test.categories) && test.categories[0]) || "Senza categoria";
      const date = classId ? (test.classDates || {})[classId] : null;

      results.push({
        id: test.id,
        title: test.title || "Verifica",
        subject: test.subject || "",
        category,
        date,
        score,
        student: fullName
      });

      (version.sections || []).forEach((section) => {
        if (!hasAnySectionScore(studentScores, test.id, section)) return;
        const raw = getSectionScore(studentScores, test.id, section);
        const max = getSectionMax(section);
        if (!max || max <= 0) return;
        competencyPoints.push({ name: section.name || "Sezione", pct: (raw / max) * 100 });
      });
    });

    return { results, competencyPoints };
  }

  /**
   * Aggrega un insieme di risultati grezzi (di uno o più alunni, già uniti
   * in un unico array) nella stessa forma usata dalla scheda del singolo
   * alunno: conteggio, media, competenze, categorie, periodi, migliori/peggiori.
   */
  function aggregateResults(results, competencyPoints) {
    if (!results || !results.length) return EMPTY_STATS;

    const average = results.reduce((a, r) => a + r.score, 0) / results.length;

    // Con pochi risultati, migliori/peggiori possono coincidere in parte: è
    // corretto (con 2 voti in tutto, quelli SONO sia il migliore che il
    // peggiore) — niente deduplicazione forzata tra le due liste.
    const sortedDesc = [...results].sort((a, b) => b.score - a.score);
    const best = sortedDesc.slice(0, 3);
    const worst = sortedDesc.slice(-3).reverse();

    const categoryAcc = {};
    results.forEach((r) => {
      if (!categoryAcc[r.category]) categoryAcc[r.category] = { sum: 0, count: 0 };
      categoryAcc[r.category].sum += r.score;
      categoryAcc[r.category].count += 1;
    });

    const periodAcc = {};
    results.forEach((r) => {
      const period = quadrimestreForDate(r.date);
      if (!period) return;
      if (!periodAcc[period]) periodAcc[period] = { sum: 0, count: 0 };
      periodAcc[period].sum += r.score;
      periodAcc[period].count += 1;
    });

    const competencyAcc = {};
    (competencyPoints || []).forEach((p) => {
      if (!competencyAcc[p.name]) competencyAcc[p.name] = { sum: 0, count: 0 };
      competencyAcc[p.name].sum += p.pct;
      competencyAcc[p.name].count += 1;
    });

    const competencies = Object.entries(competencyAcc)
      .map(([name, v]) => ({ name, avg: v.sum / v.count, count: v.count }))
      .sort((a, b) => b.avg - a.avg);

    const categories = Object.entries(categoryAcc)
      .map(([name, v]) => ({ name, avg: v.sum / v.count, count: v.count }))
      .sort((a, b) => b.avg - a.avg);

    const periods = QUADRIMESTRE_LABELS
      .map((label) => ({ label, acc: periodAcc[label] || null }))
      .filter((p) => p.acc)
      .map((p) => ({ label: p.label, avg: p.acc.sum / p.acc.count, count: p.acc.count }));

    return {
      testCount: results.length,
      average,
      competencies,
      categories,
      periods,
      best,
      worst
    };
  }

  /**
   * Calcola le statistiche voti di UN alunno da Teacher Registro (usata
   * dalla scheda alunno — tab Rendimento).
   *
   * @param {string} fullName - "Cognome Nome", stesso ID usato in classroomanager
   *   (roster e /users/{uid}/grading/scores condividono questa chiave).
   * @param {string|null} classId - id persistente della classe attuale
   *   dell'alunno (da FirebaseService.fetchGradingData().classIdByName),
   *   usato per leggere test.classDates e determinare il quadrimestre.
   * @param {object} gradingData - il campo "grading" restituito da
   *   FirebaseService.fetchGradingData().
   */
  function computeStudentStats(fullName, classId, gradingData) {
    const { results, competencyPoints } = computeStudentResults(fullName, classId, gradingData);
    return aggregateResults(results, competencyPoints);
  }

  /**
   * Calcola le statistiche voti di un GRUPPO di alunni (una classe, o tutti
   * gli alunni), unendo i risultati grezzi di ciascuno prima di aggregare —
   * usata dalla pagina Statistiche generale e dal confronto tra classi.
   *
   * @param {Array<{fullName: string, classId: string|null}>} students
   * @param {object} gradingData
   */
  function computeGroupStats(students, gradingData) {
    let allResults = [];
    let allCompetencyPoints = [];
    (students || []).forEach(({ fullName, classId }) => {
      const { results, competencyPoints } = computeStudentResults(fullName, classId || null, gradingData);
      allResults = allResults.concat(results);
      allCompetencyPoints = allCompetencyPoints.concat(competencyPoints);
    });
    return aggregateResults(allResults, allCompetencyPoints);
  }

  /**
   * Conta le verifiche DISTINTE (non i voti) che hanno almeno un voto
   * inserito da qualcuno, filtrate per classe se classIds è fornito.
   * Usata per "quante verifiche ho fatto" — a differenza di testCount in
   * aggregateResults() (che conta i voti, non le verifiche uniche).
   *
   * @param {object} gradingData
   * @param {Array<string>|null} classIds - se null, conta su tutte le classi.
   */
  function countDistinctTests(gradingData, classIds) {
    if (!gradingData) return 0;
    const allTests = [...toArray(gradingData.tests), ...toArray(gradingData.archivedTests)].filter(Boolean);
    const scores = gradingData.scores || {};
    const classIdSet = classIds ? new Set(classIds.filter(Boolean)) : null;
    let count = 0;
    allTests.forEach((test) => {
      if (!test || !test.id) return;
      if (classIdSet) {
        const testClassIds = Array.isArray(test.classIds) ? test.classIds : [];
        if (!testClassIds.some((id) => classIdSet.has(String(id)))) return;
      }
      const hasSomeone = Object.values(scores).some((byTest) => byTest && byTest[test.id]);
      if (hasSomeone) count += 1;
    });
    return count;
  }

  window.GradingStats = {
    computeStudentStats,
    computeStudentResults,
    aggregateResults,
    computeGroupStats,
    countDistinctTests
  };
})();