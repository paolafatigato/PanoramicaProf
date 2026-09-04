(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // CONFIGURAZIONE
  // ---------------------------------------------------------------------
  const ALLOWED_EMAILS = ["paola.fatigato@gmail.com"];

  const CLASS_LIST = ["1A", "1B", "2A", "2B", "3A", "3B"];
  // Colori di riserva, usati solo finché Teacher Registro non è collegata
  // o per una classe a cui non è ancora stato assegnato un colore lì.
  const CLASS_COLOR_FALLBACK = {
    "1A": "var(--class-red)",
    "1B": "var(--tiger-flame)",
    "2A": "var(--bright-gold)",
    "2B": "var(--mint-leaf)",
    "3A": "var(--sky-blue)",
    "3B": "var(--lilac)"
  };

  const SUBJECTS = [
    ["rateEnglish", "Inglese"], ["rateMath", "Matematica"], ["rateScience", "Scienze"],
    ["rateItalian", "Italiano"], ["rateLiterature", "Lettere"], ["rateArt", "Arte"],
    ["rateMusic", "Musica"], ["rateTheater", "Teatro"], ["ratePE", "Ed. fisica"],
    ["rateTechnology", "Tecnologia"], ["rateGeography", "Geografia"], ["rateHistory", "Storia"],
    ["rateInformatics", "Informatica"], ["rateDance", "Danza"], ["rateCrafts", "Attività manuali"]
  ];

  const LESSON_STYLES = [
    ["lessonListening", "Ascolto"], ["lessonAlone", "Da solo/a"],
    ["lessonPairs", "In coppia"], ["lessonGroups", "In gruppo"],
    ["lessonVideos", "Video"], ["lessonMoving", "Movimento"],
    ["lessonSpeaking", "Speaking"], ["lessonOral", "Verifiche orali"],
    ["lessonGames", "Giochi"], ["lessonWritten", "Verifiche scritte"]
  ];

  const FAVORITE_SUBJECT_OPTIONS = [
    ["English", "Inglese"], ["Math", "Matematica"], ["Science", "Scienze"], ["Italian", "Italiano"],
    ["Literature", "Lettere"], ["Art", "Arte"], ["Music", "Musica"], ["Theater", "Teatro"],
    ["P.E.", "Educazione fisica"], ["Technology", "Tecnologia"], ["Geography", "Geografia"],
    ["History", "Storia"], ["Informatics", "Informatica"], ["Dance", "Danza"], ["Crafts", "Attività manuali"]
  ];

  const ENGLISH_FOCUS_OPTIONS = [
    ["Speaking", "Speaking"], ["Listening", "Listening"], ["Writing", "Writing"],
    ["Reading", "Reading"], ["Pronunciation", "Pronuncia"], ["Vocabulary", "Vocabolario"]
  ];

  const STUDY_PLACE_OPTIONS = [["Home", "casa"], ["Library", "biblioteca"], ["Other", "un altro posto"]];

  const SELECT_OPTIONS_BY_FIELD = {
    className: CLASS_LIST.map((c) => [c, c]),
    favoriteSubject: FAVORITE_SUBJECT_OPTIONS
  };

  const TABS = [
    { id: "habits", icon: "⏰", label: "Casa e abitudini" },
    { id: "hobbies", icon: "🎨", label: "Hobby" },
    { id: "subjects", icon: "📚", label: "Materie" },
    { id: "english", icon: "💬", label: "Inglese" },
    { id: "lessons", icon: "🧑‍🏫", label: "Lezioni" },
    { id: "rendimento", icon: "📈", label: "Rendimento" },
    { id: "notes", icon: "📝", label: "Notes" }
  ];

  // Campi "di servizio" delle risposte del questionario, mai copiati nei profili
  const RESPONSE_META_KEYS = new Set([
    "id", "submittedAt", "timezone", "userAgent", "matchStatus", "matchedProfileId", "matchNote"
  ]);

  // ---------------------------------------------------------------------
  // STATO
  // ---------------------------------------------------------------------
  let allResponses = [];      // risposte grezze del questionario (collezione "responses")
  let allProfiles = [];       // schede di PanoramicaProf (collezione "profiles")
  let roster = null;          // elenco reale da Classroom Manager, null finché non collegata
  let classColorMap = {};     // colori classe letti da Teacher Registro, indicizzati per nome classe
  let allStudents = [];       // profili da mostrare: roster reale + 1 di prova
  let archivedProfiles = [];  // profili non più nel roster reale (non cancellati)
  let pendingResponses = [];  // risposte non abbinabili a nessun alunno del roster

  let classroomConnected = false;
  let isLoadingData = false;
  let reloadQueued = false;

  let currentClass = "ALL";
  let currentStudentId = null;
  let currentSectionId = "habits";
  let currentView = "roster";
  let currentQueueMode = "pending";
  let navContext = [];
  let searchDebounce = null;
  let footerHintTimeout = null;

  // ---------------------------------------------------------------------
  // RIFERIMENTI DOM
  // ---------------------------------------------------------------------
  const gateEl = document.getElementById("gate");
  const gateStatusEl = document.getElementById("gateStatus");
  const gateSignInBtn = document.getElementById("gateSignInBtn");
  const appEl = document.getElementById("app");

  const searchInput = document.getElementById("searchInput");
  const searchResultsEl = document.getElementById("searchResults");
  const signOutBtn = document.getElementById("signOutBtn");
  const authEmailEl = document.getElementById("authEmail");

  const classroomBanner = document.getElementById("classroomBanner");
  const connectClassroomBtn = document.getElementById("connectClassroomBtn");
  const queuePillsEl = document.getElementById("queuePills");

  const classTabsEl = document.getElementById("classTabs");

  const rosterViewEl = document.getElementById("rosterView");
  const rosterTitleEl = document.getElementById("rosterTitle");
  const rosterCountEl = document.getElementById("rosterCount");
  const rosterGridEl = document.getElementById("rosterGrid");
  const emptyStateEl = document.getElementById("emptyState");
  const addStudentBtn = document.getElementById("addStudentBtn");
  const addStudentCard = document.getElementById("addStudentCard");
  const newFirstName = document.getElementById("newFirstName");
  const newLastName = document.getElementById("newLastName");
  const newClassName = document.getElementById("newClassName");
  const createStudentBtn = document.getElementById("createStudentBtn");
  const cancelAddStudentBtn = document.getElementById("cancelAddStudentBtn");

  const detailViewEl = document.getElementById("detailView");
  const prevArrow = document.getElementById("prevStudent");
  const nextArrow = document.getElementById("nextStudent");
  const backToRosterBtn = document.getElementById("backToRoster");
  const studentHeadEl = document.getElementById("studentHead");
  const sectionTabsEl = document.getElementById("sectionTabs");
  const sectionContentEl = document.getElementById("sectionContent");
  const saveStatusEl = document.getElementById("saveStatus");
  const detailFooterActionEl = document.getElementById("detailFooterAction");
  const defaultFooterHint = saveStatusEl.textContent;

  const queueViewEl = document.getElementById("queueView");
  const queueTitleEl = document.getElementById("queueTitle");
  const queueHintEl = document.getElementById("queueHint");
  const queueListEl = document.getElementById("queueList");
  const backFromQueueBtn = document.getElementById("backFromQueue");

  populateClassSelect(newClassName);

  // ---------------------------------------------------------------------
  // UTILITÀ GENERICHE
  // ---------------------------------------------------------------------
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function flattenValue(value) {
    if (Array.isArray(value)) return value.join(" | ");
    if (value && typeof value === "object" && typeof value.toDate === "function") {
      try { return value.toDate().toLocaleString("it-IT"); } catch (e) { /* noop */ }
    }
    if (value && typeof value === "object") {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return value == null ? "" : String(value);
  }

  function optionLabel(options, value, fallback) {
    const found = (options || []).find(([v]) => v === value);
    return found ? found[1] : (fallback !== undefined ? fallback : "");
  }

  function slugify(str) {
    return (str || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "");
  }

  function getClassValue(row) {
    const v = row.className || row.class || row.classe;
    return v ? String(v).trim().toUpperCase() : "";
  }

  // Colore di una classe: quello impostato in Teacher Registro se disponibile,
  // altrimenti il colore di riserva locale.
  function classColor(cls) {
    return classColorMap[cls] || CLASS_COLOR_FALLBACK[cls] || "var(--space-indigo)";
  }

  function studentDisplayName(s) {
    if (s.firstName || s.lastName) return `${s.firstName || ""} ${s.lastName || ""}`.trim();
    if (s.displayName) return s.displayName;
    if (s.fullName) return s.fullName;
    return "Alunno senza nome";
  }

  function studentInitials(s) {
    if (s.firstName || s.lastName) {
      return `${(s.firstName || "?")[0] || ""}${(s.lastName || "")[0] || ""}`.toUpperCase();
    }
    const parts = (s.displayName || s.fullName || "?").trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0] || "").join("").toUpperCase();
  }

  function getStudentById(id) {
    return allStudents.find((s) => s.id === id);
  }

  function updateLocalStudent(id, payload) {
    const idx = allStudents.findIndex((s) => s.id === id);
    if (idx >= 0) allStudents[idx] = { ...allStudents[idx], ...payload };
    const pIdx = allProfiles.findIndex((p) => p.id === id);
    if (pIdx >= 0) allProfiles[pIdx] = { ...allProfiles[pIdx], ...payload };
  }

  function getStudentsForClass(cls) {
    const list = cls === "ALL" ? allStudents.slice() : allStudents.filter((s) => getClassValue(s) === cls);
    list.sort((a, b) => {
      const an = `${a.lastName || a.fullName || ""} ${a.firstName || ""}`.trim().toLowerCase();
      const bn = `${b.lastName || b.fullName || ""} ${b.firstName || ""}`.trim().toLowerCase();
      return an.localeCompare(bn, "it");
    });
    return list;
  }

  function populateClassSelect(select) {
    if (!select) return;
    select.innerHTML = CLASS_LIST.map((c) => `<option value="${c}">${c}</option>`).join("");
  }

  function rosterNameSlug(entry) {
    return slugify(entry.fullName);
  }

  function responseNameSlug(r) {
    return slugify(`${r.lastName || ""} ${r.firstName || ""}`);
  }

  function isActiveRosterProfile(student) {
    if (!student || student.isTestProfile || !roster) return false;
    return roster.some((e) => rosterNameSlug(e) === student.id);
  }

  function extractQuestionnaireFields(r) {
    const out = {};
    Object.keys(r).forEach((k) => { if (!RESPONSE_META_KEYS.has(k)) out[k] = r[k]; });
    return out;
  }

  // ---------------------------------------------------------------------
  // GATE / AUTENTICAZIONE (progetto 1: student-id-90c40)
  // ---------------------------------------------------------------------
  function showGate(state, email) {
    if (state === null) {
      gateEl.hidden = true;
      appEl.hidden = false;
      return;
    }
    gateEl.hidden = false;
    appEl.hidden = true;
    if (state === "signed-out") {
      gateStatusEl.textContent = "Accedi con l'account Google autorizzato per continuare.";
    } else if (state === "not-allowed") {
      gateStatusEl.textContent = `L'account ${email} non è autorizzato ad accedere a PanoramicaProf.`;
    } else if (state === "error") {
      gateStatusEl.textContent = "Accesso non riuscito. Riprova.";
    }
  }

  gateSignInBtn.addEventListener("click", async () => {
    try {
      await window.FirebaseService.signInWithGoogle();
    } catch (error) {
      console.error(error);
      showGate("error");
    }
  });

  signOutBtn.addEventListener("click", async () => {
    try {
      await window.FirebaseService.signOut();
    } catch (error) {
      console.error(error);
    }
  });

  if (window.FirebaseService && window.FirebaseService.onAuthStateChanged) {
    window.FirebaseService.onAuthStateChanged(async (user) => {
      if (!user) {
        showGate("signed-out");
        return;
      }
      if (ALLOWED_EMAILS.length > 0 && !ALLOWED_EMAILS.includes(user.email)) {
        showGate("not-allowed", user.email);
        return;
      }
      authEmailEl.textContent = user.email || "";
      showGate(null);
      loadData();
    });
  } else {
    showGate("error");
  }

  // --- Collegamento a Classroom Manager (progetto 2, sola lettura) -----
  connectClassroomBtn.addEventListener("click", async () => {
    connectClassroomBtn.disabled = true;
    try {
      await window.FirebaseService.signInClassroom();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a collegarmi a Classroom Manager. Riprova.");
    } finally {
      connectClassroomBtn.disabled = false;
    }
  });

  if (window.FirebaseService && window.FirebaseService.onClassroomAuthStateChanged) {
    window.FirebaseService.onClassroomAuthStateChanged((user) => {
      classroomConnected = Boolean(user);
      classroomBanner.hidden = classroomConnected;
      if (!appEl.hidden) loadData();
    });
  }

  // ---------------------------------------------------------------------
  // CARICAMENTO DATI + ABBINAMENTO CON L'ELENCO REALE
  // ---------------------------------------------------------------------
  async function loadData() {
    if (isLoadingData) { reloadQueued = true; return; }
    isLoadingData = true;
    try {
      try {
        [allResponses, allProfiles] = await Promise.all([
          window.FirebaseService.fetchResponses(),
          window.FirebaseService.fetchProfiles()
        ]);
      } catch (error) {
        console.error(error);
        alert("Non sono riuscita a caricare i dati. Controlla le regole di Firestore.");
        allResponses = []; allProfiles = [];
      }

      roster = null;
      if (window.FirebaseService.isClassroomConnected()) {
        try {
          roster = await window.FirebaseService.fetchRoster();
        } catch (error) {
          console.error(error);
          roster = null;
        }
        try {
          classColorMap = await window.FirebaseService.fetchClassColors();
        } catch (error) {
          console.error(error);
          classColorMap = {};
        }
      }

      if (roster && roster.length) {
        await reconcile(roster, allResponses, allProfiles);
      }

      computeDerivedLists();
      renderClassTabs();
      renderQueuePills();
      showView("roster");
      renderRoster();
    } finally {
      isLoadingData = false;
      if (reloadQueued) { reloadQueued = false; loadData(); }
    }
  }

  function computeDerivedLists() {
    if (roster && roster.length) {
      const rosterSlugs = new Set(roster.map((e) => rosterNameSlug(e)).filter(Boolean));
      allStudents = allProfiles.filter((p) => p.isTestProfile || rosterSlugs.has(p.id));
      archivedProfiles = allProfiles.filter((p) => !p.isTestProfile && !rosterSlugs.has(p.id));
    } else {
      allStudents = [];
      archivedProfiles = [];
    }
    pendingResponses = allResponses.filter((r) => r.matchStatus === "pending");
  }

  // Sincronizza i profili con il roster reale e prova ad abbinare le risposte non ancora processate.
  async function reconcile(rosterList, responses, profiles) {
    const rosterIndex = new Map();
    rosterList.forEach((entry) => {
      const slug = rosterNameSlug(entry);
      if (!slug) return;
      if (!rosterIndex.has(slug)) rosterIndex.set(slug, []);
      rosterIndex.get(slug).push(entry);
    });

    // 1) Crea/aggiorna un profilo per ogni alunno reale (mai tocca i campi già presenti)
    const seedJobs = rosterList.map((entry) => {
      const id = rosterNameSlug(entry);
      if (!id) return Promise.resolve();
      return window.FirebaseService.seedProfile(id, {
        fullName: entry.fullName,
        displayName: entry.displayName,
        className: entry.className,
        isTestProfile: false
      }).catch((err) => console.error("Errore sincronizzazione profilo", entry.fullName, err));
    });
    await Promise.all(seedJobs);

    rosterList.forEach((entry) => {
      const id = rosterNameSlug(entry);
      if (!id) return;
      const existing = profiles.find((p) => p.id === id);
      const base = { fullName: entry.fullName, displayName: entry.displayName, className: entry.className, isTestProfile: false };
      if (existing) Object.assign(existing, base);
      else profiles.push({ id, ...base });
    });

    // 2) Prova ad abbinare automaticamente le risposte non ancora processate
    function matchResponse(r) {
      const slug = responseNameSlug(r);
      if (!slug) return null;
      const candidates = rosterIndex.get(slug);
      if (!candidates || !candidates.length) return null;
      if (candidates.length === 1) return candidates[0];
      const respClass = (r.className || "").trim().toUpperCase();
      const byClass = candidates.filter((c) => (c.className || "").trim().toUpperCase() === respClass);
      return byClass.length === 1 ? byClass[0] : null;
    }

    const jobs = responses.map(async (r) => {
      if (r.matchStatus) return;
      const match = matchResponse(r);
      if (!match) {
        try {
          await window.FirebaseService.updateResponse(r.id, { matchStatus: "pending" });
          r.matchStatus = "pending";
        } catch (err) { console.error(err); }
        return;
      }
      const profileId = rosterNameSlug(match);
      const profile = profiles.find((p) => p.id === profileId);
      if (profile && profile.linkedResponseId) {
        try {
          await window.FirebaseService.updateResponse(r.id, { matchStatus: "pending", matchNote: "possibile doppia compilazione" });
          r.matchStatus = "pending";
          r.matchNote = "possibile doppia compilazione";
        } catch (err) { console.error(err); }
        return;
      }
      const fields = extractQuestionnaireFields(r);
      try {
        await Promise.all([
          window.FirebaseService.seedProfile(profileId, { ...fields, linkedResponseId: r.id }),
          window.FirebaseService.updateResponse(r.id, { matchStatus: "matched", matchedProfileId: profileId })
        ]);
        r.matchStatus = "matched";
        r.matchedProfileId = profileId;
        if (profile) Object.assign(profile, fields, { linkedResponseId: r.id });
      } catch (err) { console.error("Errore associazione automatica", err); }
    });

    await Promise.all(jobs);
  }

  // ---------------------------------------------------------------------
  // VISTE
  // ---------------------------------------------------------------------
  function showView(view) {
    currentView = view;
    rosterViewEl.hidden = view !== "roster";
    detailViewEl.hidden = view !== "detail";
    queueViewEl.hidden = view !== "queue";
    prevArrow.hidden = view !== "detail";
    nextArrow.hidden = view !== "detail";
  }

  backFromQueueBtn.addEventListener("click", () => {
    showView("roster");
    renderRoster();
  });

  // ---------------------------------------------------------------------
  // TAB CLASSI
  // ---------------------------------------------------------------------
  function renderClassTabs() {
    const counts = {};
    CLASS_LIST.forEach((c) => { counts[c] = 0; });
    allStudents.forEach((s) => {
      const c = getClassValue(s);
      if (counts[c] !== undefined) counts[c] += 1;
    });
    let html = `<button type="button" class="choice-chip${currentClass === "ALL" ? " is-selected" : ""}" data-class-tab="ALL">Tutti (${allStudents.length})</button>`;
    CLASS_LIST.forEach((c) => {
      const color = classColor(c);
      html += `<button type="button" class="choice-chip class-chip${currentClass === c ? " is-selected" : ""}" data-class="${c}" data-class-tab="${c}" style="--chip-color:${color}"><span class="class-chip-dot"></span>${c} <span class="class-chip-count">(${counts[c]})</span></button>`;
    });
    classTabsEl.innerHTML = html;
  }

  classTabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-class-tab]");
    if (!btn) return;
    currentClass = btn.dataset.classTab;
    if (newClassName && currentClass !== "ALL") newClassName.value = currentClass;
    renderClassTabs();
    showView("roster");
    renderRoster();
  });

  // ---------------------------------------------------------------------
  // PILLOLE "IN SOSPESO" / "NON PIÙ IN ELENCO"
  // ---------------------------------------------------------------------
  function renderQueuePills() {
    let html = "";
    if (pendingResponses.length) {
      html += `<button type="button" class="queue-pill" data-queue-mode="pending">⏳ In sospeso (${pendingResponses.length})</button>`;
    }
    if (archivedProfiles.length) {
      html += `<button type="button" class="queue-pill archived-pill" data-queue-mode="archived">🗄️ Non più in elenco (${archivedProfiles.length})</button>`;
    }
    queuePillsEl.innerHTML = html;
  }

  queuePillsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-queue-mode]");
    if (!btn) return;
    currentQueueMode = btn.dataset.queueMode;
    showView("queue");
    renderQueueView();
  });

  // ---------------------------------------------------------------------
  // ROSTER (elenco a griglia per classe)
  // ---------------------------------------------------------------------
  function renderRoster() {
    addStudentBtn.hidden = allProfiles.some((p) => p.isTestProfile);

    const list = getStudentsForClass(currentClass);
    rosterTitleEl.textContent = currentClass === "ALL" ? "Tutti gli alunni" : `Classe ${currentClass}`;
    rosterCountEl.textContent = `${list.length} alunn${list.length === 1 ? "o" : "i"}`;
    if (!list.length) {
      rosterGridEl.innerHTML = "";
      emptyStateEl.hidden = false;
      const p = emptyStateEl.querySelector("p");
      if (p) {
        p.textContent = roster
          ? "Nessun alunno qui."
          : "Collega Classroom Manager (banner qui sopra) per importare l'elenco degli alunni.";
      }
      return;
    }
    emptyStateEl.hidden = true;
    rosterGridEl.innerHTML = list.map((s) => rosterCardHTML(s)).join("");
  }

  function rosterCardHTML(s) {
    const cls = getClassValue(s);
    const color = classColor(cls);
    const initials = studentInitials(s);
    const photo = s.photoUrl
      ? `<img class="roster-photo" src="${escapeHtml(s.photoUrl)}" alt="" />`
      : `<div class="roster-photo">${escapeHtml(initials || "?")}</div>`;
    const testBadge = s.isTestProfile ? `<span class="test-badge">prova</span>` : "";
    return `
      <div class="roster-card" role="button" tabindex="0" data-id="${s.id}" style="--chip-color:${color}">
        ${photo}
        <div class="roster-name">${escapeHtml(studentDisplayName(s))}${testBadge}</div>
        <div class="roster-sub">${escapeHtml(cls || "—")}</div>
      </div>`;
  }

  rosterGridEl.addEventListener("click", (e) => {
    const card = e.target.closest(".roster-card");
    if (!card) return;
    openStudentFromRoster(card.dataset.id);
  });

  rosterGridEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".roster-card");
    if (!card) return;
    e.preventDefault();
    openStudentFromRoster(card.dataset.id);
  });

  // ---------------------------------------------------------------------
  // PROFILO DI PROVA (l'unico che si può creare/eliminare da qui)
  // ---------------------------------------------------------------------
  addStudentBtn.addEventListener("click", () => {
    addStudentCard.hidden = !addStudentCard.hidden;
    if (!addStudentCard.hidden) {
      if (currentClass !== "ALL") newClassName.value = currentClass;
      newFirstName.focus();
    }
  });

  cancelAddStudentBtn.addEventListener("click", () => {
    addStudentCard.hidden = true;
    newFirstName.value = "";
    newLastName.value = "";
  });

  createStudentBtn.addEventListener("click", async () => {
    const firstName = newFirstName.value.trim();
    const lastName = newLastName.value.trim();
    const className = newClassName.value;
    if (!firstName || !lastName) {
      alert("Inserisci nome e cognome per il profilo di prova.");
      return;
    }
    if (allProfiles.some((p) => p.isTestProfile)) {
      alert("Hai già un profilo di prova. Eliminalo prima di crearne uno nuovo.");
      return;
    }
    const fullName = `${lastName} ${firstName}`;
    const id = `test-${slugify(fullName) || "prova"}`;
    createStudentBtn.disabled = true;
    try {
      await window.FirebaseService.seedProfile(id, {
        firstName, lastName, className, fullName,
        displayName: `${firstName} ${(lastName[0] || "").toUpperCase()}.`,
        isTestProfile: true
      });
      allProfiles.push({ id, firstName, lastName, className, fullName, isTestProfile: true });
      addStudentCard.hidden = true;
      newFirstName.value = "";
      newLastName.value = "";
      computeDerivedLists();
      renderClassTabs();
      renderRoster();
      openStudentFromRoster(id);
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a creare il profilo di prova. Controlla le regole di Firestore (collezione \"profiles\").");
    } finally {
      createStudentBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  // RICERCA (sempre visibile in alto)
  // ---------------------------------------------------------------------
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      hideSearchResults();
      return;
    }
    searchDebounce = setTimeout(() => runSearch(query), 120);
  });

  function runSearch(query) {
    const matches = allStudents
      .filter((s) => studentDisplayName(s).toLowerCase().includes(query) || getClassValue(s).toLowerCase().includes(query))
      .slice(0, 8);
    if (!matches.length) {
      searchResultsEl.innerHTML = `<div class="search-result-item">Nessun alunno trovato.</div>`;
      searchResultsEl.hidden = false;
      return;
    }
    searchResultsEl.innerHTML = matches.map((s) => `
      <div class="search-result-item" data-id="${s.id}">
        <span>${escapeHtml(studentDisplayName(s))}</span>
        <span class="search-result-badge">${escapeHtml(getClassValue(s) || "—")}</span>
      </div>`).join("");
    searchResultsEl.hidden = false;
  }

  function hideSearchResults() {
    searchResultsEl.hidden = true;
    searchResultsEl.innerHTML = "";
  }

  searchResultsEl.addEventListener("click", (e) => {
    const item = e.target.closest(".search-result-item[data-id]");
    if (!item) return;
    openStudentFromSearch(item.dataset.id);
    searchInput.value = "";
    hideSearchResults();
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideSearchResults();
      searchInput.blur();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) hideSearchResults();
    if (!e.target.closest(".queue-associate-wrap")) {
      document.querySelectorAll(".queue-associate-results").forEach((el) => { el.hidden = true; });
    }
  });

  // ---------------------------------------------------------------------
  // NAVIGAZIONE TRA ALUNNI (frecce laterali + tastiera)
  // ---------------------------------------------------------------------
  function openStudentFromRoster(id) {
    navContext = getStudentsForClass(currentClass).map((s) => s.id);
    goToStudent(id);
    showView("detail");
  }

  function openStudentFromSearch(id) {
    currentClass = "ALL";
    renderClassTabs();
    navContext = getStudentsForClass("ALL").map((s) => s.id);
    goToStudent(id);
    showView("detail");
  }

  // keepSection=true quando si passa da un alunno all'altro con le frecce
  // (si resta sulla stessa scheda, es. da Rendimento a Rendimento); quando si
  // apre un alunno dal roster o dalla ricerca si riparte invece da "habits".
  function goToStudent(id, keepSection) {
    currentStudentId = id;
    if (!keepSection) currentSectionId = "habits";
    renderStudentHead();
    renderFooterAction();
    renderTabs();
    renderSectionContent();
    updateNavArrowsState();
    resetFooterHint();
  }

  // Piccola animazione direzionale sulla scheda quando si passa all'alunno
  // successivo/precedente, per far percepire che è la stessa scheda che
  // "scorre" verso il prossimo alunno, non una schermata nuova.
  function playCardTransition(direction) {
    const card = detailViewEl.querySelector(".student-card");
    if (!card) return;
    card.classList.remove("nav-enter-left", "nav-enter-right");
    void card.offsetWidth; // forza il reflow per far ripartire l'animazione
    card.classList.add(direction === "prev" ? "nav-enter-left" : "nav-enter-right");
  }

  function updateNavArrowsState() {
    const index = navContext.indexOf(currentStudentId);
    prevArrow.disabled = index <= 0;
    nextArrow.disabled = index < 0 || index >= navContext.length - 1;
    const posEl = document.getElementById("studentPosition");
    if (posEl) {
      const where = currentClass === "ALL" ? "su tutti gli alunni" : `nella classe ${currentClass}`;
      posEl.textContent = index >= 0 ? `Alunno ${index + 1} di ${navContext.length} ${where}` : "";
    }
  }

  prevArrow.addEventListener("click", () => {
    const index = navContext.indexOf(currentStudentId);
    if (index > 0) {
      goToStudent(navContext[index - 1], true);
      playCardTransition("prev");
    }
  });

  nextArrow.addEventListener("click", () => {
    const index = navContext.indexOf(currentStudentId);
    if (index >= 0 && index < navContext.length - 1) {
      goToStudent(navContext[index + 1], true);
      playCardTransition("next");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (currentView !== "detail") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return;
    if (e.key === "ArrowLeft") prevArrow.click();
    if (e.key === "ArrowRight") nextArrow.click();
  });

  backToRosterBtn.addEventListener("click", () => {
    showView("roster");
    renderRoster();
  });

  // ---------------------------------------------------------------------
  // TESTATA SCHEDA ALUNNO (foto, nome, classe, nome preferito)
  // ---------------------------------------------------------------------
  function renderStudentHead() {
    const student = getStudentById(currentStudentId);
    if (!student) return;
    const cls = getClassValue(student);
    const color = classColor(cls);
    const initials = studentInitials(student);
    const photoHTML = student.photoUrl
      ? `<img class="photo-circle" id="photoImg" src="${escapeHtml(student.photoUrl)}" alt="Foto di ${escapeHtml(studentDisplayName(student))}" />`
      : `<div class="photo-circle" id="photoImg" role="button" tabindex="0">${escapeHtml(initials || "?")}</div>`;

    const locked = isActiveRosterProfile(student);
    const classBadgeHTML = locked
      ? `<span class="class-badge" style="--chip-color:${color}" title="Classe gestita in Classroom Manager">${escapeHtml(cls || "—")}</span>`
      : slot("className", "select", student.className, { placeholder: cls || "—", extraClass: "class-badge", style: `--chip-color:${color}` });
    const testBadge = student.isTestProfile ? `<span class="test-badge">profilo di prova</span>` : "";

    studentHeadEl.innerHTML = `
      <div class="photo-wrap">
        ${photoHTML}
        <button type="button" class="photo-edit-btn" id="photoEditBtn" title="Cambia foto" aria-label="Cambia foto">📷</button>
        <input type="file" accept="image/*" id="photoFileInput" hidden />
      </div>
      <div class="student-meta">
        <div class="student-position" id="studentPosition"></div>
        <div class="student-name-row">
          <h2>${escapeHtml(studentDisplayName(student))}</h2>
          ${classBadgeHTML}${testBadge}
        </div>
        <div class="student-preferred">Si fa chiamare ${slot("preferredName", "text", student.preferredName, { placeholder: "…" })}</div>
        ${student.photoUrl ? `<button type="button" class="photo-remove-btn" id="photoRemoveBtn">Rimuovi foto</button>` : ""}
        <div class="uploading" id="uploadingMsg" hidden>Caricamento foto…</div>
      </div>`;

    const photoImg = document.getElementById("photoImg");
    const photoEditBtn = document.getElementById("photoEditBtn");
    const photoFileInput = document.getElementById("photoFileInput");
    const photoRemoveBtn = document.getElementById("photoRemoveBtn");

    const openPicker = () => photoFileInput.click();
    photoEditBtn.addEventListener("click", openPicker);
    photoImg.addEventListener("click", openPicker);
    photoImg.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
    });
    photoFileInput.addEventListener("change", () => {
      const file = photoFileInput.files && photoFileInput.files[0];
      if (file) handlePhotoFile(file);
    });
    if (photoRemoveBtn) photoRemoveBtn.addEventListener("click", removePhoto);
  }

  // Elimina/Gestisci in fondo alla scheda: link a Classroom Manager per gli alunni reali,
  // pulsante di eliminazione vero per il profilo di prova o i profili archiviati.
  function renderFooterAction() {
    const student = getStudentById(currentStudentId);
    if (!student) { detailFooterActionEl.innerHTML = ""; return; }
    if (isActiveRosterProfile(student)) {
      detailFooterActionEl.innerHTML = `<a class="footer-link" href="https://paolafatigato.github.io/Class-Manager/" target="_blank" rel="noopener">Gestisci l'elenco in Classroom Manager ↗</a>`;
    } else {
      const label = student.isTestProfile ? "Elimina profilo di prova" : "Elimina scheda";
      detailFooterActionEl.innerHTML = `<button type="button" class="link-danger" id="deleteStudentBtn">${label}</button>`;
      document.getElementById("deleteStudentBtn").addEventListener("click", handleDeleteCurrentStudent);
    }
  }

  async function handleDeleteCurrentStudent() {
    const student = getStudentById(currentStudentId);
    if (!student) return;
    const confirmed = confirm(`Eliminare definitivamente la scheda di ${studentDisplayName(student)}? L'operazione non si può annullare.`);
    if (!confirmed) return;
    try {
      await window.FirebaseService.deleteProfile(currentStudentId);
      await window.FirebaseService.deletePhoto(currentStudentId);
      allProfiles = allProfiles.filter((p) => p.id !== currentStudentId);
      computeDerivedLists();
      renderClassTabs();
      renderQueuePills();
      showView("roster");
      renderRoster();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a eliminare la scheda. Controlla le regole di Firestore.");
    }
  }

  // ---------------------------------------------------------------------
  // FOTO: compressione lato client + upload su Storage
  // ---------------------------------------------------------------------
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const maxSize = 480;
          let { width, height } = img;
          if (width > height) {
            if (width > maxSize) { height *= maxSize / width; width = maxSize; }
          } else if (height > maxSize) {
            width *= maxSize / height; height = maxSize;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Compressione non riuscita."))), "image/jpeg", 0.82);
        };
        img.onerror = () => reject(new Error("Immagine non valida."));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error("Lettura del file non riuscita."));
      reader.readAsDataURL(file);
    });
  }

  async function handlePhotoFile(file) {
    if (!file.type || !file.type.startsWith("image/")) {
      alert("Seleziona un file immagine.");
      return;
    }
    const uploadingMsg = document.getElementById("uploadingMsg");
    if (uploadingMsg) uploadingMsg.hidden = false;
    try {
      const blob = await compressImage(file);
      const url = await window.FirebaseService.uploadPhoto(currentStudentId, blob);
      await window.FirebaseService.updateProfile(currentStudentId, { photoUrl: url });
      updateLocalStudent(currentStudentId, { photoUrl: url });
      renderStudentHead();
      renderRoster();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a caricare la foto: " + error.message);
      if (uploadingMsg) uploadingMsg.hidden = true;
    }
  }

  async function removePhoto() {
    if (!currentStudentId) return;
    if (!confirm("Rimuovere la foto di questo alunno?")) return;
    try {
      await window.FirebaseService.deletePhoto(currentStudentId);
      await window.FirebaseService.updateProfile(currentStudentId, { photoUrl: "" });
      updateLocalStudent(currentStudentId, { photoUrl: "" });
      renderStudentHead();
      renderRoster();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a rimuovere la foto.");
    }
  }

  // ---------------------------------------------------------------------
  // TAB DI SEZIONE
  // ---------------------------------------------------------------------
  function renderTabs() {
    sectionTabsEl.innerHTML = TABS.map((sec) => `
      <li>
        <button type="button" class="choice-chip pano-tab-btn${sec.id === currentSectionId ? " is-selected" : ""}" data-section="${sec.id}">
          ${sec.icon} ${escapeHtml(sec.label)}
        </button>
      </li>`).join("");
  }

  sectionTabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-section]");
    if (!btn) return;
    currentSectionId = btn.dataset.section;
    renderTabs();
    renderSectionContent();
  });

  // ---------------------------------------------------------------------
  // SLOT SINGOLI (valori brevi: classe, nome preferito, materia preferita, link)
  // ---------------------------------------------------------------------
  function displayForField(field, type, rawValue) {
    if (type === "select") return optionLabel(SELECT_OPTIONS_BY_FIELD[field], rawValue, "");
    if (type === "rating") return rawValue ? String(rawValue) : "";
    return flattenValue(rawValue);
  }

  function slot(field, type, rawValue, opts) {
    opts = opts || {};
    const placeholder = opts.placeholder || "…";
    const display = displayForField(field, type, rawValue);
    const isEmpty = !display;
    const extraClass = opts.extraClass ? ` ${opts.extraClass}` : "";
    const style = opts.style ? ` style="${opts.style}"` : "";
    return `<span class="edit-slot${extraClass}${isEmpty ? " empty" : ""}" data-field="${field}" data-type="${type}" data-placeholder="${escapeHtml(placeholder)}" tabindex="0" role="button" aria-label="Modifica"${style}>${escapeHtml(isEmpty ? placeholder : display)}</span>`;
  }

  function quoteBlock(field, rawValue, placeholder) {
    placeholder = placeholder || "Clicca per scrivere…";
    const value = flattenValue(rawValue);
    const isEmpty = !value;
    return `<div class="quote-block${isEmpty ? " empty" : ""}" data-field="${field}" data-type="textarea" data-placeholder="${escapeHtml(placeholder)}" tabindex="0" role="button" aria-label="Modifica">${escapeHtml(isEmpty ? placeholder : value)}</div>`;
  }

  function quoteBlockLabeled(labelText, field, rawValue, placeholder) {
    return `<div class="quote-wrap"><p class="quote-caption">${escapeHtml(labelText)}</p>${quoteBlock(field, rawValue, placeholder)}</div>`;
  }

  function editableText(field, student, seedFn) {
    const has = Object.prototype.hasOwnProperty.call(student, field);
    const text = has ? flattenValue(student[field]) : seedFn(student);
    const placeholder = "Clicca per scrivere…";
    const isEmpty = has && !text;
    const display = isEmpty ? placeholder : text;
    return `<p class="editable-text${isEmpty ? " empty" : ""}" data-field="${field}" data-type="freetext" data-placeholder="${escapeHtml(placeholder)}" tabindex="0" role="button" aria-label="Modifica">${escapeHtml(display)}</p>`;
  }

  // ---------------------------------------------------------------------
  // FRASI DI PARTENZA (finché non viene salvata una versione propria)
  // ---------------------------------------------------------------------
  function homeLifeSeed(s) {
    return `A casa vive con ${s.livesWith || "…"} e si parla ${s.languagesHome || "…"}.`;
  }
  function studyHabitsSeed(s) {
    const label = optionLabel(STUDY_PLACE_OPTIONS, s.studyPlace, "…");
    const other = (s.studyPlace === "Other" || (s.studyOther || "").trim()) ? ` (${s.studyOther || "specifica dove"})` : "";
    return `Studia in genere ${label}${other}, con l'aiuto di ${s.studyHelper || "…"}.`;
  }
  function sleepScreenSeed(s) {
    return `Passa ${s.screenTime || "?"} ore al giorno davanti agli schermi, inizia i compiti alle ${s.homeworkStart || "…"}, va a letto alle ${s.bedTime || "…"} e si sveglia alle ${s.wakeTime || "…"} — circa ${s.sleepHours || "?"} ore di sonno.`;
  }
  function hobbiesMainSeed(s) {
    return `Nel tempo libero ama ${s.hobbySummary || "…"}. Il weekend preferisce ${s.weekendLove || "…"}.`;
  }
  function hobbiesGoodSeed(s) {
    return `È particolarmente brava/o in ${s.goodAt1 || "…"}, ${s.goodAt2 || "…"} e ${s.goodAt3 || "…"}.`;
  }
  function hobbiesHardSeed(s) {
    return `Trova più difficile ${s.difficult1 || "…"}, ${s.difficult2 || "…"} e ${s.difficult3 || "…"}.`;
  }
  function englishIntroSeed(s) {
    const focusLabel = optionLabel(ENGLISH_FOCUS_OPTIONS, s.englishFocus, "…");
    return `Si sente ${s.englishConfidence || "–"}/5 sicura/o in inglese, lo studia da ${s.englishYears || "…"}, con un focus su ${focusLabel}.`;
  }

  // ---------------------------------------------------------------------
  // PALLINI DI VALUTAZIONE (piccoli) + commento libero, ordinati per gradimento
  // ---------------------------------------------------------------------
  function dotsButtonsHTML(value) {
    const val = parseInt(value, 10) || 0;
    let html = "";
    for (let i = 1; i <= 5; i += 1) {
      html += `<button type="button" class="dot${i <= val ? " filled" : ""}" data-dot-value="${i}" aria-label="Voto ${i} su 5"></button>`;
    }
    return html;
  }

  function sortedRatingPairs(pairs, student) {
    return pairs.slice().sort((a, b) => {
      const av = parseInt(student[a[0]], 10) || 0;
      const bv = parseInt(student[b[0]], 10) || 0;
      if (av !== bv) return bv - av;
      return a[1].localeCompare(b[1], "it");
    });
  }

  function ratingListHTML(pairs, student) {
    const sorted = sortedRatingPairs(pairs, student);
    const rows = sorted.map(([key, label]) => {
      const commentField = `${key}Comment`;
      const comment = flattenValue(student[commentField]);
      return `
        <div class="rate-row">
          <span class="rate-label">${escapeHtml(label)}</span>
          <span class="dots-rating" data-field="${key}">${dotsButtonsHTML(student[key])}</span>
          <input type="text" class="rate-comment" data-field="${commentField}" value="${escapeHtml(comment)}" placeholder="commento…" />
        </div>`;
    }).join("");
    return `<div class="rate-list">${rows}</div>`;
  }

  // ---------------------------------------------------------------------
  // CONTENUTO DELLE SEZIONI
  // ---------------------------------------------------------------------
  function renderHabits(s) {
    return editableText("noteHomeLife", s, homeLifeSeed)
      + editableText("noteStudyHabits", s, studyHabitsSeed)
      + editableText("noteSleepScreen", s, sleepScreenSeed);
  }

  function renderHobbies(s) {
    return editableText("noteHobbiesMain", s, hobbiesMainSeed)
      + editableText("noteHobbiesGood", s, hobbiesGoodSeed)
      + editableText("noteHobbiesHard", s, hobbiesHardSeed);
  }

  function renderSubjects(s) {
    return `
      <p class="prose">Materia preferita: ${slot("favoriteSubject", "select", s.favoriteSubject, { placeholder: "…" })}</p>
      ${quoteBlockLabeled("Perché", "favoriteSubjectReason", s.favoriteSubjectReason)}
      ${ratingListHTML(SUBJECTS, s)}`;
  }

  function renderEnglish(s) {
    return editableText("noteEnglishIntro", s, englishIntroSeed)
      + quoteBlockLabeled("Vuole imparare", "englishGoal", s.englishGoal)
      + quoteBlockLabeled("La preoccupa", "englishWorry", s.englishWorry);
  }

  function renderLessons(s) {
    return `
      ${ratingListHTML(LESSON_STYLES, s)}
      <div class="lesson-best">
        ${quoteBlockLabeled("🏆 La lezione migliore di sempre", "bestLessons", s.bestLessons)}
      </div>`;
  }

  const PERF_SKILLS = [
    ["perfReading", "Leggere", "var(--mint-leaf)"],
    ["perfWriting", "Scrivere", "var(--bright-gold)"],
    ["perfSpeaking", "Parlare", "var(--tiger-flame)"],
    ["perfListening", "Ascoltare", "var(--plum)"],
    ["perfActing", "Recitare", "var(--sky-blue)"],
    ["perfComputer", "PC", "var(--lilac)"]
  ];

  function perfRowHTML(key, label, color, student) {
    const noteField = `${key}Note`;
    const value = student[key] ? parseInt(student[key], 10) : 5;
    const pct = Math.round(((value - 1) / 9) * 100);
    const note = flattenValue(student[noteField]);
    return `
      <div class="perf-row">
        <div class="perf-row-header">
          <span class="perf-label">${escapeHtml(label)}</span>
          <span class="perf-value">${value}/10</span>
        </div>
        <input type="range" class="perf-slider" min="1" max="10" step="1" value="${value}" data-field="${key}" style="--fill:${pct}%;--fill-color:${color};" />
        <input type="text" class="perf-note" data-field="${noteField}" value="${escapeHtml(note)}" placeholder="Note su ${escapeHtml(label.toLowerCase())}…" />
      </div>`;
  }

  function renderRendimento(s) {
    const rows = PERF_SKILLS.map(([key, label, color]) => perfRowHTML(key, label, color, s)).join("");
    return `
      <p class="prose"><a class="btn btn-outline" href="https://paolafatigato.github.io/RegistroTeacher/" target="_blank" rel="noopener">📖 Apri Teacher Registro ↗</a></p>
      <div class="perf-list">${rows}</div>`;
  }

  function renderNotes(s) {
    const has = Object.prototype.hasOwnProperty.call(s, "teacherNotes");
    const placeholder = "Scrivi qui le tue note su questo alunno — osservazioni, colloqui con la famiglia, progressi…";
    const text = has ? flattenValue(s.teacherNotes) : "";
    const isEmpty = !text;
    return `<div class="notes-block${isEmpty ? " empty" : ""}" data-field="teacherNotes" data-type="freetext" data-placeholder="${escapeHtml(placeholder)}" tabindex="0" role="button" aria-label="Modifica note">${escapeHtml(isEmpty ? placeholder : text)}</div>`;
  }

  const SECTION_RENDERERS = {
    habits: renderHabits,
    hobbies: renderHobbies,
    subjects: renderSubjects,
    english: renderEnglish,
    lessons: renderLessons,
    rendimento: renderRendimento,
    notes: renderNotes
  };

  function renderSectionContent() {
    const student = getStudentById(currentStudentId);
    if (!student) return;
    const renderer = SECTION_RENDERERS[currentSectionId];
    sectionContentEl.innerHTML = renderer ? renderer(student) : "";
  }

  // ---------------------------------------------------------------------
  // MODIFICA IN LINEA: clic su testo/parola → campo di modifica
  // ---------------------------------------------------------------------
  function activateEditor(el) {
    if (el.classList.contains("editing")) return;
    const field = el.dataset.field;
    const type = el.dataset.type;
    const student = getStudentById(currentStudentId);
    if (!student) return;
    const rawValue = student[field];
    el.classList.add("editing");
    const originalHTML = el.innerHTML;
    let inputEl;

    if (type === "select") {
      const options = SELECT_OPTIONS_BY_FIELD[field] || [];
      inputEl = document.createElement("select");
      inputEl.innerHTML = `<option value="">—</option>` +
        options.map(([v, l]) => `<option value="${escapeHtml(v)}"${v === rawValue ? " selected" : ""}>${escapeHtml(l)}</option>`).join("");
    } else if (type === "time") {
      inputEl = document.createElement("input");
      inputEl.type = "time";
      inputEl.value = rawValue || "";
    } else if (type === "textarea") {
      inputEl = document.createElement("textarea");
      inputEl.value = flattenValue(rawValue);
      inputEl.rows = Math.min(10, Math.max(3, Math.ceil(inputEl.value.length / 46)));
    } else if (type === "freetext") {
      inputEl = document.createElement("textarea");
      inputEl.value = el.classList.contains("empty") ? "" : el.textContent;
      inputEl.rows = Math.min(12, Math.max(2, Math.ceil(inputEl.value.length / 46)));
    } else {
      inputEl = document.createElement("input");
      inputEl.type = "text";
      inputEl.value = flattenValue(rawValue);
    }
    inputEl.className = "inline-editor";

    el.innerHTML = "";
    el.appendChild(inputEl);
    inputEl.focus();
    if (inputEl.select) inputEl.select();

    let settled = false;
    const finish = (save) => {
      if (settled) return;
      settled = true;
      el.classList.remove("editing");
      if (!save) {
        el.innerHTML = originalHTML;
        return;
      }
      commitFieldEdit(el, field, type, inputEl.value);
    };

    inputEl.addEventListener("blur", () => finish(true));
    inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      else if (ev.key === "Enter" && type !== "textarea" && type !== "freetext") { ev.preventDefault(); inputEl.blur(); }
      else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); inputEl.blur(); }
    });
  }

  function renderSlotDisplay(el, field, type) {
    const student = getStudentById(currentStudentId);
    const rawValue = student ? student[field] : "";
    const placeholder = el.dataset.placeholder || "…";
    if (el.matches(".quote-block, .editable-text, .notes-block")) {
      const value = flattenValue(rawValue);
      const isEmpty = !value;
      el.classList.toggle("empty", isEmpty);
      el.textContent = isEmpty ? placeholder : value;
      return;
    }
    const display = displayForField(field, type, rawValue);
    const isEmpty = !display;
    el.classList.toggle("empty", isEmpty);
    el.textContent = isEmpty ? placeholder : display;
  }

  function flashFooter(text, ms) {
    clearTimeout(footerHintTimeout);
    saveStatusEl.textContent = text;
    footerHintTimeout = setTimeout(() => { saveStatusEl.textContent = defaultFooterHint; }, ms || 2200);
  }

  function resetFooterHint() {
    clearTimeout(footerHintTimeout);
    saveStatusEl.textContent = defaultFooterHint;
  }

  async function commitFieldEdit(el, field, type, newValue) {
    if (!currentStudentId) return;
    const payload = { [field]: newValue };
    try {
      await window.FirebaseService.updateProfile(currentStudentId, payload);
      updateLocalStudent(currentStudentId, payload);
      renderSlotDisplay(el, field, type);
      el.classList.add("just-saved");
      setTimeout(() => el.classList.remove("just-saved"), 900);

      if (field === "className") {
        renderStudentHead();
        renderClassTabs();
        renderRoster();
        navContext = getStudentsForClass(currentClass).map((st) => st.id);
        updateNavArrowsState();
      } else if (field === "preferredName") {
        renderRoster();
      }
    } catch (error) {
      console.error(error);
      el.classList.add("save-error");
      setTimeout(() => el.classList.remove("save-error"), 1600);
      renderSlotDisplay(el, field, type);
      flashFooter("⚠️ Modifica non salvata: controlla la connessione o le regole di Firestore.", 3500);
    }
  }

  async function saveSimpleField(field, value, feedbackEl) {
    if (!currentStudentId) return;
    const payload = { [field]: value };
    try {
      await window.FirebaseService.updateProfile(currentStudentId, payload);
      updateLocalStudent(currentStudentId, payload);
      if (feedbackEl) {
        feedbackEl.classList.add("just-saved");
        setTimeout(() => feedbackEl.classList.remove("just-saved"), 700);
      }
    } catch (error) {
      console.error(error);
      if (feedbackEl) {
        feedbackEl.classList.add("save-error");
        setTimeout(() => feedbackEl.classList.remove("save-error"), 1600);
      }
      flashFooter("⚠️ Modifica non salvata: controlla la connessione o le regole di Firestore.", 3500);
    }
  }

  detailViewEl.addEventListener("click", (e) => {
    const dotBtn = e.target.closest(".dot");
    if (dotBtn) {
      const group = dotBtn.closest(".dots-rating");
      const field = group.dataset.field;
      const clicked = parseInt(dotBtn.dataset.dotValue, 10);
      const student = getStudentById(currentStudentId);
      const current = parseInt(student[field], 10) || 0;
      const newValue = current === clicked ? "" : String(clicked);
      group.innerHTML = dotsButtonsHTML(newValue);
      saveSimpleField(field, newValue, group);
      return;
    }
    const el = e.target.closest(".edit-slot, .quote-block, .editable-text, .notes-block");
    if (!el || el.classList.contains("editing")) return;
    activateEditor(el);
  });

  detailViewEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest(".edit-slot, .quote-block, .editable-text, .notes-block");
    if (!el || el.classList.contains("editing")) return;
    e.preventDefault();
    activateEditor(el);
  });

  detailViewEl.addEventListener("focusout", (e) => {
    const input = e.target.closest(".rate-comment, .perf-note");
    if (!input) return;
    saveSimpleField(input.dataset.field, input.value, input);
  });

  // Barre "Rendimento": aggiornamento live mentre si trascina, salvataggio al rilascio
  detailViewEl.addEventListener("input", (e) => {
    const slider = e.target.closest(".perf-slider");
    if (!slider) return;
    const val = parseInt(slider.value, 10);
    const pct = Math.round(((val - 1) / 9) * 100);
    slider.style.setProperty("--fill", `${pct}%`);
    const valueLabel = slider.closest(".perf-row")?.querySelector(".perf-value");
    if (valueLabel) valueLabel.textContent = `${val}/10`;
  });

  detailViewEl.addEventListener("change", (e) => {
    const slider = e.target.closest(".perf-slider");
    if (!slider) return;
    saveSimpleField(slider.dataset.field, slider.value, slider);
  });

  // ---------------------------------------------------------------------
  // CODA: risposte in sospeso da associare, profili non più in elenco
  // ---------------------------------------------------------------------
  function renderQueueView() {
    if (currentQueueMode === "pending") {
      queueTitleEl.textContent = "Risposte in sospeso";
      queueHintEl.textContent = "Il nome scritto nel questionario non corrisponde a nessun alunno del tuo elenco (o corrisponde a più di uno). Associa manualmente, oppure elimina se non pertinente.";
      queueListEl.innerHTML = pendingResponses.length
        ? pendingResponses.map(pendingCardHTML).join("")
        : `<p class="extra-note">Nessuna risposta in sospeso al momento.</p>`;
    } else {
      queueTitleEl.textContent = "Non più in Classroom Manager";
      queueHintEl.textContent = "Questi profili non risultano più nell'elenco reale (alunno rimosso o spostato). I dati restano salvati: puoi eliminarli definitivamente se non servono più.";
      queueListEl.innerHTML = archivedProfiles.length
        ? archivedProfiles.map(archivedCardHTML).join("")
        : `<p class="extra-note">Nessun profilo archiviato al momento.</p>`;
    }
  }

  function pendingCardHTML(r) {
    const name = `${r.firstName || ""} ${r.lastName || ""}`.trim() || "(nome non scritto)";
    const cls = r.className || "—";
    const date = r.submittedAt && typeof r.submittedAt.toDate === "function"
      ? r.submittedAt.toDate().toLocaleDateString("it-IT")
      : "";
    const note = r.matchNote ? ` — ${escapeHtml(r.matchNote)}` : "";
    return `
      <div class="queue-card">
        <div class="queue-card-header">
          <span class="queue-card-name">${escapeHtml(name)}</span>
          <span class="queue-card-meta">scritto: classe ${escapeHtml(cls)}${date ? " · " + escapeHtml(date) : ""}${note}</span>
        </div>
        <button type="button" class="queue-toggle-answers" data-toggle-answers="${r.id}">Vedi le risposte</button>
        <div class="queue-answers" hidden></div>
        <div class="queue-card-actions">
          <div class="queue-associate-wrap">
            <input type="text" class="queue-associate-input" placeholder="Associa a un alunno…" data-associate-for="${r.id}" autocomplete="off" />
            <div class="queue-associate-results" hidden></div>
          </div>
          <button type="button" class="link-danger" data-discard="${r.id}">Elimina risposta</button>
        </div>
      </div>`;
  }

  function archivedCardHTML(p) {
    return `
      <div class="queue-card">
        <div class="queue-card-header">
          <span class="queue-card-name">${escapeHtml(studentDisplayName(p))}</span>
          <span class="queue-card-meta">era in classe ${escapeHtml(getClassValue(p) || "—")}</span>
        </div>
        <div class="queue-card-actions">
          <button type="button" class="link-danger" data-purge="${p.id}">Elimina definitivamente</button>
        </div>
      </div>`;
  }

  queueListEl.addEventListener("click", (e) => {
    const toggleBtn = e.target.closest("[data-toggle-answers]");
    if (toggleBtn) { toggleAnswers(toggleBtn); return; }
    const discardBtn = e.target.closest("[data-discard]");
    if (discardBtn) { discardResponse(discardBtn.dataset.discard); return; }
    const purgeBtn = e.target.closest("[data-purge]");
    if (purgeBtn) { purgeProfile(purgeBtn.dataset.purge); return; }
    const resultItem = e.target.closest(".queue-associate-item[data-profile-id]");
    if (resultItem) { associateResponseToProfile(resultItem.dataset.responseId, resultItem.dataset.profileId); }
  });

  queueListEl.addEventListener("input", (e) => {
    const input = e.target.closest(".queue-associate-input");
    if (!input) return;
    const responseId = input.dataset.associateFor;
    const query = input.value.trim().toLowerCase();
    const resultsEl = input.parentElement.querySelector(".queue-associate-results");
    if (!query) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
    const matches = allStudents.filter((s) => studentDisplayName(s).toLowerCase().includes(query)).slice(0, 6);
    resultsEl.innerHTML = matches.length
      ? matches.map((s) => `<div class="queue-associate-item" data-response-id="${responseId}" data-profile-id="${s.id}">${escapeHtml(studentDisplayName(s))} <span style="opacity:.5">(${escapeHtml(getClassValue(s) || "—")})</span></div>`).join("")
      : `<div class="queue-associate-item" style="opacity:.5;cursor:default;">Nessun alunno trovato</div>`;
    resultsEl.hidden = false;
  });

  function toggleAnswers(btn) {
    const panel = btn.nextElementSibling;
    if (!panel) return;
    if (!panel.hidden) { panel.hidden = true; btn.textContent = "Vedi le risposte"; return; }
    const responseId = btn.dataset.toggleAnswers;
    const response = allResponses.find((r) => r.id === responseId);
    if (response) {
      const keys = Object.keys(response).filter((k) => !RESPONSE_META_KEYS.has(k));
      panel.innerHTML = keys.map((k) => `<div><b>${escapeHtml(k)}</b>${escapeHtml(flattenValue(response[k]))}</div>`).join("");
    }
    panel.hidden = false;
    btn.textContent = "Nascondi le risposte";
  }

  async function associateResponseToProfile(responseId, profileId) {
    const response = allResponses.find((r) => r.id === responseId);
    const profile = allProfiles.find((p) => p.id === profileId);
    if (!response || !profile) return;
    const fields = extractQuestionnaireFields(response);
    try {
      await Promise.all([
        window.FirebaseService.updateProfile(profileId, { ...fields, linkedResponseId: responseId }),
        window.FirebaseService.updateResponse(responseId, { matchStatus: "matched", matchedProfileId: profileId })
      ]);
      Object.assign(profile, fields, { linkedResponseId: responseId });
      response.matchStatus = "matched";
      response.matchedProfileId = profileId;
      computeDerivedLists();
      renderQueuePills();
      renderQueueView();
      renderRoster();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita ad associare questa risposta. Riprova.");
    }
  }

  async function discardResponse(responseId) {
    if (!confirm("Eliminare questa risposta del questionario? Non potrà più essere recuperata.")) return;
    try {
      await window.FirebaseService.deleteResponse(responseId);
      allResponses = allResponses.filter((r) => r.id !== responseId);
      computeDerivedLists();
      renderQueuePills();
      renderQueueView();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a eliminare questa risposta.");
    }
  }

  async function purgeProfile(profileId) {
    const profile = allProfiles.find((p) => p.id === profileId);
    if (!profile) return;
    const confirmed = confirm(`Eliminare definitivamente la scheda di ${studentDisplayName(profile)}? Non si può annullare.`);
    if (!confirmed) return;
    try {
      await window.FirebaseService.deleteProfile(profileId);
      await window.FirebaseService.deletePhoto(profileId);
      allProfiles = allProfiles.filter((p) => p.id !== profileId);
      computeDerivedLists();
      renderQueuePills();
      renderQueueView();
    } catch (error) {
      console.error(error);
      alert("Non sono riuscita a eliminare questa scheda.");
    }
  }
})();