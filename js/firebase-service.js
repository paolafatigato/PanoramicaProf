(function () {
  // =====================================================================
  //  PROGETTO 1: student-id-90c40 — stesso del questionario studenti.
  //  Qui vivono le risposte grezze (collezione "responses", scritte
  //  pubblicamente dal questionario) e le schede di PanoramicaProf
  //  (collezione "profiles", gestite solo da qui).
  // =====================================================================
  const firebaseConfig = {
    apiKey: "AIzaSyDV1V5EsL2WAVwC_IO2OB9_OjGHqEUZlRY",
    authDomain: "student-id-90c40.firebaseapp.com",
    projectId: "student-id-90c40",
    storageBucket: "student-id-90c40.firebasestorage.app",
    messagingSenderId: "530724046561",
    appId: "1:530724046561:web:ddafe2a49a08b610ed99a0"
  };

  // =====================================================================
  //  PROGETTO 2: classroomanager — stesso di Classroom Manager e
  //  Teacher Registro (Realtime Database). Qui leggiamo SOLO l'elenco
  //  reale degli alunni (/users/{uid}/classes), in sola lettura: non
  //  scriviamo mai nulla in questo progetto da PanoramicaProf.
  // =====================================================================
  const classroomConfig = {
    apiKey: "AIzaSyA6O12KFRkZ4gGBi2LEGKZni33c3a2NBcU",
    authDomain: "classroomanager.firebaseapp.com",
    databaseURL: "https://classroomanager-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "classroomanager",
    storageBucket: "classroomanager.firebasestorage.app",
    messagingSenderId: "995055049853",
    appId: "1:995055049853:web:5b3674ae12f7c0b504e514"
  };

  let db = null;
  let auth = null;
  let storage = null;

  let classroomApp = null;
  let classroomAuth = null;
  let classroomDb = null;

  // --- Progetto 1: student-id-90c40 ------------------------------------
  function init() {
    if (!window.firebase || !window.firebase.firestore) {
      console.error("Firebase SDK non caricato.");
      return false;
    }
    if (!firebase.apps.some((a) => a.name === "[DEFAULT]")) {
      firebase.initializeApp(firebaseConfig);
    }
    db = firebase.firestore();
    if (firebase.auth) auth = firebase.auth();
    if (firebase.storage) storage = firebase.storage();
    return true;
  }

  function isReady() {
    return Boolean(db);
  }

  function getCurrentUser() {
    return auth ? auth.currentUser : null;
  }

  function onAuthStateChanged(callback) {
    if (!auth) {
      callback(null);
      return () => {};
    }
    return auth.onAuthStateChanged(callback);
  }

  async function signInWithGoogle() {
    if (!auth) throw new Error("Firebase Auth non disponibile.");
    const provider = new firebase.auth.GoogleAuthProvider();
    return auth.signInWithPopup(provider);
  }

  async function signOut() {
    if (!auth) return;
    return auth.signOut();
  }

  // --- Risposte grezze del questionario (collezione "responses") -------
  async function fetchResponses() {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    const snapshot = await db.collection("responses").orderBy("submittedAt", "desc").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  async function updateResponse(id, data) {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    if (!id) throw new Error("ID mancante.");
    return db.collection("responses").doc(id).update(data);
  }

  async function deleteResponse(id) {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    if (!id) throw new Error("ID mancante.");
    return db.collection("responses").doc(id).delete();
  }

  // --- Schede di PanoramicaProf (collezione "profiles") -----------------
  async function fetchProfiles() {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    const snapshot = await db.collection("profiles").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  // Crea o "riempie" un profilo senza toccare i campi già presenti
  // (usato per seminare i profili dal roster di Classroom Manager).
  async function seedProfile(id, data) {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    return db.collection("profiles").doc(id).set(data, { merge: true });
  }

  async function updateProfile(id, data) {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    if (!id) throw new Error("ID mancante.");
    const payload = { ...data, lastEditedAt: firebase.firestore.FieldValue.serverTimestamp() };
    return db.collection("profiles").doc(id).update(payload);
  }

  async function deleteProfile(id) {
    if (!db && !init()) throw new Error("Firebase non configurato.");
    if (!id) throw new Error("ID mancante.");
    return db.collection("profiles").doc(id).delete();
  }

  // --- Foto (Storage, condiviso, indicizzato per id profilo) -----------
  async function uploadPhoto(id, blob) {
    if (!storage) {
      if (!init() || !storage) {
        throw new Error("Firebase Storage non disponibile. Vai su Firebase Console > Storage e attivalo.");
      }
    }
    const ref = storage.ref().child(`studentPhotos/${id}.jpg`);
    await ref.put(blob, { contentType: "image/jpeg" });
    return ref.getDownloadURL();
  }

  async function deletePhoto(id) {
    if (!storage) return;
    try {
      await storage.ref().child(`studentPhotos/${id}.jpg`).delete();
    } catch (error) {
      console.warn("Impossibile eliminare la foto su Storage", error);
    }
  }

  // =====================================================================
  //  Progetto 2: classroomanager — solo lettura dell'elenco alunni reale
  // =====================================================================
  function initClassroom() {
    if (classroomDb) return true;
    if (!window.firebase || !window.firebase.database) {
      console.error("Firebase Database SDK non caricato (serve firebase-database-compat.js).");
      return false;
    }
    try {
      classroomApp = firebase.apps.find((a) => a.name === "classroomManager")
        || firebase.initializeApp(classroomConfig, "classroomManager");
      classroomAuth = classroomApp.auth();
      classroomDb = classroomApp.database();
      return true;
    } catch (error) {
      console.error("Impossibile collegarsi a Classroom Manager.", error);
      return false;
    }
  }

  function isClassroomConnected() {
    return Boolean(classroomAuth && classroomAuth.currentUser);
  }

  function getClassroomUser() {
    return classroomAuth ? classroomAuth.currentUser : null;
  }

  function onClassroomAuthStateChanged(callback) {
    if (!initClassroom()) {
      callback(null);
      return () => {};
    }
    return classroomAuth.onAuthStateChanged(callback);
  }

  async function signInClassroom() {
    if (!classroomAuth && !initClassroom()) throw new Error("Impossibile collegarsi a Classroom Manager.");
    const provider = new firebase.auth.GoogleAuthProvider();
    return classroomAuth.signInWithPopup(provider);
  }

  async function signOutClassroom() {
    if (!classroomAuth) return;
    return classroomAuth.signOut();
  }

  // Legge i colori delle classi impostati in Teacher Registro
  // (users/{uid}/grading/settings/classColors, indicizzati per id classe)
  // e li abbina al nome classe usando /users/{uid}/classes. Sola lettura:
  // così il colore si imposta una volta sola in Teacher Registro e vale ovunque.
  async function fetchClassColors() {
    if (!classroomDb) throw new Error("Non collegata a Classroom Manager.");
    const user = getClassroomUser();
    if (!user) throw new Error("Accesso a Classroom Manager non ancora effettuato.");
    const [classesSnap, colorsSnap] = await Promise.all([
      classroomDb.ref(`users/${user.uid}/classes`).once("value"),
      classroomDb.ref(`users/${user.uid}/grading/settings/classColors`).once("value")
    ]);
    const classesData = classesSnap.val();
    const colorsById = colorsSnap.val() || {};
    const rawClasses = Array.isArray(classesData) ? classesData : Object.values(classesData || {});
    const byClassName = {};
    rawClasses.forEach((cls) => {
      if (!cls || !cls.name) return;
      const color = cls.id ? colorsById[cls.id] : null;
      if (color) byClassName[String(cls.name).trim().toUpperCase()] = color;
    });
    return byClassName;
  }

  // Legge /users/{uid}/classes e lo appiattisce in un elenco di alunni reali.
  async function fetchRoster() {
    if (!classroomDb) throw new Error("Non collegata a Classroom Manager.");
    const user = getClassroomUser();
    if (!user) throw new Error("Accesso a Classroom Manager non ancora effettuato.");
    const snap = await classroomDb.ref(`users/${user.uid}/classes`).once("value");
    const data = snap.val();
    const rawClasses = Array.isArray(data) ? data : Object.values(data || {});
    const roster = [];
    rawClasses.forEach((cls) => {
      if (!cls) return;
      const className = cls.name || "";
      const rawStudents = Array.isArray(cls.students) ? cls.students : Object.values(cls.students || {});
      rawStudents.forEach((st) => {
        if (!st) return;
        const fullName = st.fullName || st.displayName || st.name || "";
        if (!fullName.trim()) return;
        roster.push({
          fullName: fullName.trim(),
          displayName: (st.displayName || fullName).trim(),
          className: className
        });
      });
    });
    return roster;
  }

  window.FirebaseService = {
    init,
    isReady,
    getCurrentUser,
    onAuthStateChanged,
    signInWithGoogle,
    signOut,
    fetchResponses,
    updateResponse,
    deleteResponse,
    fetchProfiles,
    seedProfile,
    updateProfile,
    deleteProfile,
    uploadPhoto,
    deletePhoto,
    // Classroom Manager (sola lettura)
    isClassroomConnected,
    getClassroomUser,
    onClassroomAuthStateChanged,
    signInClassroom,
    signOutClassroom,
    fetchRoster,
    fetchClassColors
  };

  init();
  initClassroom();
})();