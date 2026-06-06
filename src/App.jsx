import React, { useState, useMemo, useEffect } from "react";
import { storage } from "./storage";

// Différé : garde la saisie fluide en recalculant le planning en arrière-plan.
// Repli sur l'identité si l'environnement React ne fournit pas useDeferredValue.
const useDeferred = (typeof React !== "undefined" && React.useDeferredValue)
  ? React.useDeferredValue
  : (v) => v;

// ============================================================
//  PROTOTYPE-DÉMO — Répartition équitable des gardes
//  Onglets : Mois (grille calendrier) · Semestre (équité
//  cumulée sur 6 mois) · Équipe (habilitations par tags).
//  Tout en mémoire, aucun serveur.
// ============================================================

const SEED_TAGS = ["Réa", "Urgences", "Bloc", "Sénior"];

const SEED_POSTS = [
  { id: "rea", label: "Réa", requires: ["Réa"], color: "#e0613c", kind: "garde", cadence: "jour" },
  { id: "urg", label: "Urgences", requires: ["Urgences"], color: "#3fb6a8", kind: "garde", cadence: "jour" },
  { id: "etage", label: "Étage", requires: [], color: "#e0a13c", kind: "astreinte", cadence: "jour" },
];

const SEED_INTERNS = [
  { id: 1, name: "Camille", tags: ["Réa", "Sénior"], carry: 4, color: "#e0613c" },
  { id: 2, name: "Yanis", tags: ["Urgences"], carry: 0, color: "#3fb6a8" },
  { id: 3, name: "Léa", tags: ["Réa", "Urgences"], carry: 2, color: "#7c9cf0" },
  { id: 4, name: "Mehdi", tags: ["Bloc", "Sénior"], carry: 1, color: "#e0a13c" },
  { id: 5, name: "Sofia", tags: ["Urgences", "Bloc"], carry: 3, color: "#c879c0" },
  { id: 6, name: "Tom", tags: ["Réa"], carry: 0, color: "#8fbf5f" },
  { id: 7, name: "Inès", tags: ["Urgences", "Sénior"], carry: 2, color: "#d98cae" },
  { id: 8, name: "Karim", tags: ["Réa", "Bloc"], carry: 1, color: "#5fb0c9" },
  { id: 9, name: "Nora", tags: ["Urgences"], carry: 0, color: "#b59cf0" },
  { id: 10, name: "Hugo", tags: ["Bloc", "Réa"], carry: 3, color: "#cf9a5f" },
];

// wd : 0=Lun … 5=Sam 6=Dim
const DEFAULT_WEIGHTS = { week: 1, sat: 2.2, sun: 2.2, holiday: 2.6 };
const DOW = ["L", "M", "M", "J", "V", "S", "D"];
const MONTH_NAMES = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

// Dimanche de Pâques (algorithme de Gauss / computus grégorien).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100,
    d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451),
    month = Math.floor((h + l - 7 * m + 114) / 31),
    day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
// Jours fériés français pour une année donnée → Set de "mois-jour".
function frenchHolidays(y) {
  const s = new Set();
  [[0, 1], [4, 1], [4, 8], [6, 14], [7, 15], [10, 1], [10, 11], [11, 25]]
    .forEach(([m, d]) => s.add(m + "-" + d));
  const E = easter(y);
  [1, 39, 50].forEach((off) => {
    const dt = new Date(E);
    dt.setDate(dt.getDate() + off); // lundi de Pâques, Ascension, lundi de Pentecôte
    s.add(dt.getMonth() + "-" + dt.getDate());
  });
  return s;
}

// Construit la liste des mois entre deux dates (incluses), avec
// longueurs/jours de semaine réels et indicateur de plage.
function buildExercise(startISO, endISO) {
  const start = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  if (isNaN(start) || isNaN(end) || end < start) return [];
  const months = [];
  let y = start.getFullYear(), m = start.getMonth();
  const holCache = {};
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    const len = new Date(y, m + 1, 0).getDate();
    const firstWd = (new Date(y, m, 1).getDay() + 6) % 7; // lundi=0
    if (!holCache[y]) holCache[y] = frenchHolidays(y);
    const hol = holCache[y];
    const days = Array.from({ length: len }, (_, i) => {
      const date = i + 1;
      const dt = new Date(y, m, date);
      const inRange = dt >= start && dt <= end;
      return { date, wd: (firstWd + i) % 7, holiday: hol.has(m + "-" + date), inRange };
    });
    months.push({ year: y, monthIdx: m, name: MONTH_NAMES[m], len, start: firstWd, days });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return months;
}

// Heuristique gloutonne : chaque créneau va à la personne
// éligible (tags ok ; pour une garde, pas la veille) la moins chargée.
function weightOf(day, W) {
  return day.holiday ? W.holiday
    : day.wd === 5 ? W.sat
    : day.wd === 6 ? W.sun
    : W.week;
}
// indices des jours de la même semaine (lun→dim) que dIdx, dans la période
function weekDaysInRange(days, dIdx) {
  let start = dIdx;
  while (start > 0 && days[start].wd !== 0) start--;
  let end = start;
  while (end + 1 < days.length && days[end + 1].wd !== 0) end++;
  const out = [];
  for (let i = start; i <= end; i++) if (days[i].inRange !== false) out.push(i);
  return out;
}
function weekAnchor(days, dIdx) {
  const w = weekDaysInRange(days, dIdx);
  return w.length ? w[0] : dIdx;
}

function generateSchedule(interns, days, startScore, unavail, posts, monthIdx, overrides, weights) {
  const W = weights || DEFAULT_WEIGHTS;
  const score = {}, count = {}, lastGarde = {};
  interns.forEach((i) => {
    score[i.id] = startScore ? startScore[i.id] || 0 : i.carry || 0;
    count[i.id] = 0;
  });
  const has = (id) => interns.some((i) => i.id === id);
  const ov = (k) => (overrides ? overrides[k] : undefined);
  const takenDay = days.map(() => new Set()); // occupation par jour, tous postes
  const dayAssign = {}; // "dIdx-postId" → internId | null
  const forcedAt = {};  // "dIdx-postId" → true
  const unav = (id, dIdx) => unavail && unavail[monthIdx + "-" + id + "-" + dIdx];

  // --- 1) postes hebdomadaires : une personne couvre toute la semaine ---
  posts.filter((p) => p.cadence === "semaine").forEach((post) => {
    const seen = new Set();
    days.forEach((day, dIdx) => {
      if (day.inRange === false) return;
      const wk = weekDaysInRange(days, dIdx);
      const anchor = wk[0];
      if (anchor == null || seen.has(anchor)) return;
      seen.add(anchor);
      const ww = wk.reduce((s, i) => s + weightOf(days[i], W), 0);
      const okey = ov(monthIdx + "-" + anchor + "-" + post.id);
      let chosenId = null, forced = false;
      if (okey !== undefined && okey !== null) {
        forced = true;
        chosenId = okey !== "" && has(okey) ? okey : null;
      } else {
        const elig = interns
          .filter((i) => post.requires.every((t) => i.tags.includes(t)))
          .filter((i) => !wk.some((d) => takenDay[d].has(i.id)))
          .filter((i) => !wk.some((d) => unav(i.id, d)))
          .sort((a, b) => score[a.id] - score[b.id]);
        chosenId = elig[0] ? elig[0].id : null;
      }
      if (chosenId) { score[chosenId] += ww; count[chosenId] += 1; }
      wk.forEach((i) => {
        dayAssign[i + "-" + post.id] = chosenId;
        if (forced) forcedAt[i + "-" + post.id] = true;
        if (chosenId) takenDay[i].add(chosenId);
      });
    });
  });

  // --- 2) postes journaliers : jour par jour (repos seulement pour une garde) ---
  days.forEach((day, dIdx) => {
    if (day.inRange === false) return;
    const w = weightOf(day, W);
    posts.filter((p) => p.cadence !== "semaine").forEach((post) => {
      const okey = ov(monthIdx + "-" + dIdx + "-" + post.id);
      if (okey !== undefined && okey !== null) {
        const id = okey !== "" && has(okey) ? okey : null;
        if (id) { score[id] += w; count[id]++; takenDay[dIdx].add(id); if (post.kind === "garde") lastGarde[id] = dIdx; }
        dayAssign[dIdx + "-" + post.id] = id; forcedAt[dIdx + "-" + post.id] = true;
        return;
      }
      const elig = interns
        .filter((i) => post.requires.every((t) => i.tags.includes(t)))
        .filter((i) => post.kind !== "garde" || lastGarde[i.id] !== dIdx - 1)
        .filter((i) => !takenDay[dIdx].has(i.id))
        .filter((i) => !unav(i.id, dIdx))
        .sort((a, b) => score[a.id] - score[b.id]);
      const chosen = elig[0];
      if (chosen) {
        score[chosen.id] += w; count[chosen.id]++; takenDay[dIdx].add(chosen.id);
        if (post.kind === "garde") lastGarde[chosen.id] = dIdx;
        dayAssign[dIdx + "-" + post.id] = chosen.id;
      } else dayAssign[dIdx + "-" + post.id] = null;
    });
  });

  // --- 3) assemblage des assignations (ordre jour → postes) ---
  const assignments = [];
  days.forEach((day, dIdx) => {
    if (day.inRange === false) return;
    posts.forEach((post) => {
      const k = dIdx + "-" + post.id;
      assignments.push({ dIdx, post: post.id, intern: dayAssign[k] ?? null, forced: !!forcedAt[k] });
    });
  });
  return { assignments, score, count };
}

function simulateSemester(interns, posts, unavail, months, overrides, weights) {
  let running = {};
  interns.forEach((i) => (running[i.id] = i.carry || 0));
  return months.map((m, mi) => {
    const res = generateSchedule(interns, m.days, running, unavail, posts, mi, overrides, weights);
    running = { ...res.score };
    return { ...m, ...res };
  });
}

const PALETTE = ["#e0613c", "#3fb6a8", "#7c9cf0", "#e0a13c", "#c879c0", "#8fbf5f", "#d98cae", "#5fb0c9", "#b59cf0", "#cf9a5f"];

// Champ texte qui ne valide qu'à la sortie (évite de recalculer à chaque frappe)
function CommitInput({ value, onCommit, style }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <input
      value={v}
      style={style}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== value) onCommit(v); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
    />
  );
}

export default function App() {
  const [interns, setInterns] = useState(SEED_INTERNS);
  const [tab, setTab] = useState("mois");
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState("plan"); // plan | indispo
  const [activePerson, setActivePerson] = useState(SEED_INTERNS[0].id);
  const [unavail, setUnavail] = useState({}); // clé "moisIdx-internId-dIdx" → true
  const [posts, setPosts] = useState(SEED_POSTS);
  const [selMonth, setSelMonth] = useState(0); // index dans la période
  const [startISO, setStartISO] = useState("2026-05-01");
  const [endISO, setEndISO] = useState("2026-10-31");
  const [overrides, setOverrides] = useState({}); // "moisIdx-dIdx-posteId" → internId | "" (vide)
  const [offers, setOffers] = useState([]); // bourse : {id, monthIdx, dIdx, postId, from}
  const [votes, setVotes] = useState({}); // "moisIdx-internId" → "pour"|"contre"
  const [validated, setValidated] = useState({}); // moisIdx → true
  const [respo, setRespo] = useState({}); // moisIdx → internId (sinon rotation auto)
  const [tagList, setTagList] = useState(SEED_TAGS);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [theme, setTheme] = useState("dark");
  const [exportWho, setExportWho] = useState("all");
  const [loaded, setLoaded] = useState(false);

  // Chargement des données enregistrées (au démarrage).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window !== "undefined" && storage) {
          const r = await storage.get("rota:state");
          if (!cancelled && r && r.value) {
            const d = JSON.parse(r.value);
            if (d.interns) setInterns(d.interns);
            if (d.posts) setPosts(d.posts);
            if (d.unavail) setUnavail(d.unavail);
            if (d.startISO) setStartISO(d.startISO);
            if (d.endISO) setEndISO(d.endISO);
            if (d.activePerson) setActivePerson(d.activePerson);
            if (d.overrides) setOverrides(d.overrides);
            if (d.offers) setOffers(d.offers);
            if (d.votes) setVotes(d.votes);
            if (d.validated) setValidated(d.validated);
            if (d.respo) setRespo(d.respo);
            if (d.tagList) setTagList(d.tagList);
            if (d.weights) setWeights({ ...DEFAULT_WEIGHTS, ...d.weights });
            if (d.theme) setTheme(d.theme);
          }
        }
      } catch (e) {
        // aucune donnée enregistrée → on garde les valeurs par défaut
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Sauvegarde automatique (débouncée) à chaque modification.
  useEffect(() => {
    if (!loaded || typeof window === "undefined" || !storage) return;
    const data = JSON.stringify({ interns, posts, unavail, startISO, endISO, activePerson, overrides, offers, votes, validated, respo, tagList, weights, theme });
    const t = setTimeout(() => { storage.set("rota:state", data).catch(() => {}); }, 400);
    return () => clearTimeout(t);
  }, [loaded, interns, posts, unavail, startISO, endISO, activePerson, overrides, offers, votes, validated, respo, tagList, weights, theme]);

  async function resetAll() {
    try { if (typeof window !== "undefined" && storage) await storage.delete("rota:state"); } catch (e) {}
    setInterns(SEED_INTERNS);
    setPosts(SEED_POSTS);
    setUnavail({});
    setStartISO("2026-05-01");
    setEndISO("2026-10-31");
    setActivePerson(SEED_INTERNS[0].id);
    setSelMonth(0);
    setOverrides({}); setOffers([]); setVotes({}); setValidated({}); setRespo({});
    setTagList(SEED_TAGS);
    setWeights(DEFAULT_WEIGHTS);
  }

  const months = useMemo(() => buildExercise(startISO, endISO), [startISO, endISO]);
  const valid = months.length > 0;

  // valeurs différées : la saisie reste fluide, le planning se recalcule juste après
  const dInterns = useDeferred(interns);
  const dPosts = useDeferred(posts);
  const dUnavail = useDeferred(unavail);
  const dOverrides = useDeferred(overrides);
  const dWeights = useDeferred(weights);
  const sem = useMemo(
    () => (valid ? simulateSemester(dInterns, dPosts, dUnavail, months, dOverrides, dWeights) : []),
    [dInterns, dPosts, dUnavail, months, valid, dOverrides, dWeights]
  );

  useEffect(() => {
    if (selMonth > months.length - 1) setSelMonth(Math.max(0, months.length - 1));
  }, [months.length, selMonth]);

  const safeMonth = Math.min(selMonth, Math.max(0, sem.length - 1));
  const cur = sem[safeMonth]; // mois affiché dans l'onglet Mois

  const maxScore = cur ? Math.max(...Object.values(cur.score), 1) : 1;
  const internMap = useMemo(() => { const m = {}; interns.forEach((i) => (m[i.id] = i)); return m; }, [interns]);
  const postMap = useMemo(() => { const m = {}; posts.forEach((p) => (m[p.id] = p)); return m; }, [posts]);
  const byId = (id) => internMap[id];
  const postById = (id) => postMap[id];
  // assignations pré-indexées par jour (évite de refiltrer la liste à chaque cellule)
  const assignByDay = useMemo(() => {
    const m = {};
    if (cur) cur.assignments.forEach((a) => { (m[a.dIdx] = m[a.dIdx] || []).push(a); });
    return m;
  }, [cur]);

  // responsable du mois : choix explicite sinon rotation automatique
  const respoOf = (mi) =>
    respo[mi] != null ? respo[mi] : (interns.length ? interns[mi % interns.length].id : null);

  // qui est assigné à un créneau (en tenant compte de la génération)
  const assignedAt = (mi, dIdx, postId) => {
    const m = sem[mi];
    if (!m) return null;
    const a = m.assignments.find((x) => x.dIdx === dIdx && x.post === postId);
    return a ? a.intern : null;
  };

  // édition manuelle : force un interne (ou "" = vide, ou null = revenir à l'auto)
  function setOverride(mi, dIdx, postId, value) {
    setOverrides((o) => {
      const n = { ...o };
      const k = mi + "-" + dIdx + "-" + postId;
      if (value === null) delete n[k];
      else n[k] = value;
      return n;
    });
  }

  // bourse : proposer une garde à l'échange
  function offerShift(mi, dIdx, postId) {
    const from = assignedAt(mi, dIdx, postId);
    if (from == null) return;
    setOffers((o) => {
      if (o.some((x) => x.monthIdx === mi && x.dIdx === dIdx && x.postId === postId)) return o;
      return [...o, { id: Date.now() + "-" + dIdx + postId, monthIdx: mi, dIdx, postId, from }];
    });
  }
  function cancelOffer(id) { setOffers((o) => o.filter((x) => x.id !== id)); }
  // attribuer une offre à un repreneur → pose une surcharge et clôt l'offre
  function takeOffer(offer, toId) {
    setOverride(offer.monthIdx, offer.dIdx, offer.postId, toId);
    cancelOffer(offer.id);
  }

  // vote / validation du mois
  function castVote(mi, internId, v) {
    setVotes((vs) => {
      const k = mi + "-" + internId;
      const n = { ...vs };
      if (n[k] === v) delete n[k]; else n[k] = v;
      return n;
    });
  }
  const voteTally = (mi) => {
    let pour = 0, contre = 0;
    interns.forEach((i) => {
      const v = votes[mi + "-" + i.id];
      if (v === "pour") pour++; else if (v === "contre") contre++;
    });
    return { pour, contre };
  };
  function toggleValidated(mi) {
    setValidated((v) => ({ ...v, [mi]: !v[mi] }));
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  function setDuration(nMonths) {
    const d = new Date(startISO + "T00:00:00");
    if (isNaN(d)) return;
    const e = new Date(d.getFullYear(), d.getMonth() + nMonths, 0); // dernier jour du mois (start + n - 1)
    setEndISO(e.getFullYear() + "-" + pad2(e.getMonth() + 1) + "-" + pad2(e.getDate()));
  }
  // --- export du planning (agenda .ics / tableau .csv) ---
  function download(name, text, mime) {
    try {
      const blob = new Blob([text], { type: mime + ";charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      alert("L'export n'est pas autorisé dans cet environnement.");
    }
  }
  function collectEvents() {
    const out = [];
    sem.forEach((m) => {
      m.assignments.forEach((a) => {
        if (a.intern == null) return;
        if (exportWho !== "all" && a.intern !== Number(exportWho)) return;
        const day = m.days[a.dIdx], p = postById(a.post), it = byId(a.intern);
        if (!day || !p || !it) return;
        out.push({ date: new Date(m.year, m.monthIdx, day.date), day, p, it });
      });
    });
    return out;
  }
  function exportICS() {
    const evs = collectEvents();
    const iso = (d) => "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    let s = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ROTA//FR\r\nCALSCALE:GREGORIAN\r\n";
    evs.forEach((e, k) => {
      const nd = new Date(e.date); nd.setDate(nd.getDate() + 1);
      const kind = (e.p.kind || "garde") === "astreinte" ? "Astreinte" : "Garde";
      s += "BEGIN:VEVENT\r\nUID:rota-" + k + "-" + Date.now() + "@rota\r\n";
      s += "DTSTART;VALUE=DATE:" + iso(e.date) + "\r\nDTEND;VALUE=DATE:" + iso(nd) + "\r\n";
      s += "SUMMARY:" + e.p.label + " \u00b7 " + e.it.name + " (" + kind + ")\r\nEND:VEVENT\r\n";
    });
    s += "END:VCALENDAR\r\n";
    download("astreintes.ics", s, "text/calendar");
  }
  function exportCSV() {
    const evs = collectEvents();
    const rows = ["Date;Jour;Type jour;Poste;Creneau;Interne"];
    evs.forEach((e) => {
      const d = e.date;
      const dd = pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
      const tj = e.day.holiday ? "Ferie" : e.day.wd === 5 ? "Samedi" : e.day.wd === 6 ? "Dimanche" : "Semaine";
      const kind = (e.p.kind || "garde") === "astreinte" ? "Astreinte" : "Garde";
      rows.push([dd, DOW[e.day.wd], tj, e.p.label, kind, e.it.name].join(";"));
    });
    download("astreintes.csv", "\ufeff" + rows.join("\r\n"), "text/csv");
  }

  // gestion des habilitations (tags) — propagation aux internes et postes
  function addTag() {
    setTagList((l) => {
      let base = "Habilitation", n = l.length + 1, name = base + " " + n;
      while (l.includes(name)) { n++; name = base + " " + n; }
      return [...l, name];
    });
  }
  function renameTag(oldName, newName) {
    const nn = newName;
    setTagList((l) => l.map((t) => (t === oldName ? nn : t)));
    setInterns((p) => p.map((i) => ({ ...i, tags: i.tags.map((t) => (t === oldName ? nn : t)) })));
    setPosts((p) => p.map((x) => ({ ...x, requires: x.requires.map((t) => (t === oldName ? nn : t)) })));
  }
  function removeTag(name) {
    setTagList((l) => l.filter((t) => t !== name));
    setInterns((p) => p.map((i) => ({ ...i, tags: i.tags.filter((t) => t !== name) })));
    setPosts((p) => p.map((x) => ({ ...x, requires: x.requires.filter((t) => t !== name) })));
  }

  function toggleTag(id, tag) {
    setInterns((p) =>
      p.map((i) =>
        i.id === id
          ? {
              ...i,
              tags: i.tags.includes(tag)
                ? i.tags.filter((t) => t !== tag)
                : [...i.tags, tag],
            }
          : i
      )
    );
  }

  function addIntern() {
    const id = Math.max(0, ...interns.map((i) => i.id)) + 1;
    const color = PALETTE[interns.length % PALETTE.length];
    setInterns((p) => [...p, { id, name: "Interne " + id, tags: [], carry: 0, color }]);
  }
  function removeIntern(id) {
    setInterns((p) => (p.length > 1 ? p.filter((i) => i.id !== id) : p));
    setUnavail((u) => {
      const n = {};
      Object.keys(u).forEach((k) => {
        if (k.split("-")[1] !== String(id)) n[k] = u[k];
      });
      return n;
    });
    if (activePerson === id) setActivePerson(interns.find((i) => i.id !== id)?.id);
  }
  function renameIntern(id, name) {
    setInterns((p) => p.map((i) => (i.id === id ? { ...i, name } : i)));
  }
  function bumpCarry(id, d) {
    setInterns((p) =>
      p.map((i) => (i.id === id ? { ...i, carry: Math.max(0, i.carry + d) } : i))
    );
  }
  function toggleUnavail(personId, dIdx) {
    const key = selMonth + "-" + personId + "-" + dIdx;
    setUnavail((u) => {
      const n = { ...u };
      if (n[key]) delete n[key];
      else n[key] = true;
      return n;
    });
  }

  function addPost() {
    const id = "p" + Date.now();
    const color = PALETTE[posts.length % PALETTE.length];
    setPosts((p) => [...p, { id, label: "Nouveau poste", requires: [], color, kind: "garde", cadence: "jour" }]);
  }
  function removePost(id) {
    setPosts((p) => (p.length > 1 ? p.filter((x) => x.id !== id) : p));
  }
  function renamePost(id, label) {
    setPosts((p) => p.map((x) => (x.id === id ? { ...x, label } : x)));
  }
  function togglePostTag(id, tag) {
    setPosts((p) =>
      p.map((x) =>
        x.id === id
          ? {
              ...x,
              requires: x.requires.includes(tag)
                ? x.requires.filter((t) => t !== tag)
                : [...x.requires, tag],
            }
          : x
      )
    );
  }
  function setPostField(id, field, value) {
    setPosts((p) => p.map((x) => (x.id === id ? { ...x, [field]: value } : x)));
  }

  const lastSem = sem.length ? sem[sem.length - 1] : null;
  const finalScores = lastSem ? interns.map((i) => lastSem.score[i.id] || 0) : [0];
  const spread = (Math.max(...finalScores) - Math.min(...finalScores)).toFixed(1);
  const maxMonthCount = Math.max(
    ...sem.flatMap((m) => interns.map((i) => m.count[i.id] || 0)),
    1
  );

  function heatBg(n) {
    const t = n / maxMonthCount;
    if (t > 0.75) return "var(--hot)";
    if (t > 0.45) return "var(--mid)";
    if (t > 0) return "var(--cool)";
    return "var(--panel2)";
  }

  if (!loaded) {
    return (
      <div className={theme === "light" ? "rota-light" : ""} style={S.shell}>
        <style>{CSS}</style>
        <div style={S.splash}>
          <div style={S.logoMark}>◷</div>
          <div style={S.splashText}>Chargement…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={theme === "light" ? "rota-light" : ""} style={S.shell}>
      <style>{CSS}</style>

      <header style={S.header}>
        <div style={S.logoRow}>
          <div style={S.logoMark}>◷</div>
          <div>
            <div style={S.appName}>ROTA</div>
            <div style={S.appSub}>astreintes équitables · perso</div>
          </div>
        </div>
        <div style={S.headRight}>
          <button
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            style={S.themeBtn}
            aria-label="Changer de thème"
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
          <select
            value={String(months.length)}
            onChange={(e) => setDuration(Number(e.target.value))}
            style={S.monthSelect}
            aria-label="Durée de l'exercice"
          >
            {Array.from(new Set([1, 3, 6, 12, months.length])).sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>{n} mois</option>
            ))}
          </select>
        </div>
      </header>

      {/* barre Exercice : période de planification */}
      <section style={S.exerciseBar}>
        <span style={S.exLabel}>Exercice</span>
        <input
          type="date"
          value={startISO}
          max={endISO}
          onChange={(e) => setStartISO(e.target.value)}
          style={S.dateInput}
        />
        <span style={S.exArrow}>→</span>
        <input
          type="date"
          value={endISO}
          min={startISO}
          onChange={(e) => setEndISO(e.target.value)}
          style={S.dateInput}
        />
      </section>

      <nav style={S.tabs}>
        {[
          ["mois", "Mois"],
          ["bourse", "Bourse" + (offers.length ? " (" + offers.length + ")" : "")],
          ["semestre", "Semestre"],
          ["equipe", "Équipe"],
          ["postes", "Postes"],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{ ...S.tab, ...(tab === k.split(" ")[0] ? S.tabActive : {}) }}
          >
            {l}
          </button>
        ))}
      </nav>

      {/* ---------------- MOIS ---------------- */}
      {tab === "mois" && (
        <section style={S.body}>
          {!valid || !cur ? (
            <div style={S.warn}>
              Choisis une date de fin postérieure à la date de début pour générer la période.
            </div>
          ) : (
          <>
          {/* navigateur de mois */}
          <div style={S.monthNav}>
            <button
              onClick={() => { setSelMonth((m) => Math.max(0, m - 1)); setSel(null); }}
              disabled={safeMonth === 0}
              style={{ ...S.navArrow, ...(safeMonth === 0 ? S.navArrowOff : {}) }}
            >
              ‹
            </button>
            <div style={S.monthTitle}>
              <span style={S.monthTitleName}>{cur.name} {cur.year}</span>
              <span style={S.monthTitleSub}>{cur.len} jours · mois {safeMonth + 1}/{months.length}</span>
            </div>
            <button
              onClick={() => { setSelMonth((m) => Math.min(months.length - 1, m + 1)); setSel(null); }}
              disabled={safeMonth >= months.length - 1}
              style={{ ...S.navArrow, ...(safeMonth >= months.length - 1 ? S.navArrowOff : {}) }}
            >
              ›
            </button>
          </div>

          {/* responsable du mois + statut de validation */}
          <div style={{ ...S.respoBar, borderColor: validated[safeMonth] ? "var(--cool)" : "var(--line)" }}>
            <div style={S.respoLeft}>
              <span style={S.respoLabel}>Responsable</span>
              <select
                value={respoOf(safeMonth) ?? ""}
                onChange={(e) => setRespo((r) => ({ ...r, [safeMonth]: Number(e.target.value) }))}
                style={S.respoSelect}
              >
                {interns.map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
            </div>
            <span style={{ ...S.statut, ...(validated[safeMonth] ? S.statutOk : {}) }}>
              {validated[safeMonth] ? "✓ Validé" : "Brouillon"}
            </span>
          </div>

          {/* sélecteur de mode */}
          <div style={S.modeRow}>
            {[
              ["plan", "Planifier"],
              ["indispo", "Indispos"],
            ].map(([k, l]) => (
              <button
                key={k}
                onClick={() => { setMode(k); setSel(null); }}
                style={{ ...S.modeBtn, ...(mode === k ? S.modeBtnOn : {}) }}
              >
                {l}
              </button>
            ))}
          </div>

          {mode === "indispo" && (
            <div style={S.personPick}>
              {interns.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setActivePerson(p.id)}
                  style={{
                    ...S.personChip,
                    ...(activePerson === p.id
                      ? { background: p.color, color: "var(--paper)", borderColor: p.color }
                      : {}),
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          <div style={S.legend}>
            {mode === "plan" ? (
              interns.map((p) => (
                <span key={p.id} style={S.legendItem}>
                  <span style={{ ...S.legendDot, background: p.color }} />
                  {p.name}
                </span>
              ))
            ) : (
              <span style={S.legendNote}>
                Touche les jours où <b style={{ color: byId(activePerson)?.color }}>{byId(activePerson)?.name}</b> n'est pas disponible. Le planning les évite.
              </span>
            )}
          </div>

          <div style={S.weekHead}>
            {DOW.map((d, i) => (
              <div key={i} style={S.weekHeadCell}>{d}</div>
            ))}
          </div>

          <div style={S.grid}>
            {Array.from({ length: cur.days[0].wd }, (_, b) => (
              <div key={"b" + b} style={S.blank} />
            ))}
            {cur.days.map((day, dIdx) => {
              const a = assignByDay[dIdx] || [];
              const special = day.holiday || day.wd === 5 || day.wd === 6;
              const isSel = sel === dIdx;
              const off = unavail[selMonth + "-" + activePerson + "-" + dIdx];
              if (!day.inRange) {
                return (
                  <div key={dIdx} style={{ ...S.cell, ...S.cellOut }}>
                    <span style={S.cellNumOut}>{day.date}</span>
                  </div>
                );
              }
              const onTap = () =>
                mode === "indispo"
                  ? toggleUnavail(activePerson, dIdx)
                  : setSel(isSel ? null : dIdx);
              return (
                <button
                  key={dIdx}
                  onClick={onTap}
                  style={{
                    ...S.cell,
                    ...(special ? S.cellSpecial : {}),
                    ...(mode === "plan" && isSel ? S.cellSel : {}),
                    ...(mode === "indispo" && off
                      ? { background: byId(activePerson)?.color, borderColor: byId(activePerson)?.color }
                      : {}),
                  }}
                >
                  <span
                    style={{
                      ...S.cellNum,
                      ...(mode === "indispo" && off ? { color: "var(--paper)" } : {}),
                    }}
                  >
                    {day.date}
                  </span>
                  {mode === "plan" ? (
                    <div style={S.dots}>
                      {a.map((x, k) => {
                        const who = x.intern ? byId(x.intern) : null;
                        return (
                          <span
                            key={k}
                            style={{
                              ...S.dot,
                              background: who ? who.color : "transparent",
                              border: who ? "none" : "1.5px solid var(--hot)",
                            }}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <span style={S.offMark}>{off ? "off" : ""}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* détail / édition du jour sélectionné (mode planifier) */}
          {mode === "plan" && (
            <div style={S.detail}>
              {sel === null ? (
                <div style={S.detailHint}>Touche un jour pour voir et modifier les astreintes.</div>
              ) : (
                <>
                  <div style={S.detailHead}>
                    {cur.name} {cur.days[sel].date} · {DOW[cur.days[sel].wd]}
                    {cur.days[sel].holiday ? " · férié" : ""}
                    {(cur.days[sel].wd === 5 || cur.days[sel].wd === 6) ? " · week-end" : ""}
                  </div>
                  {(assignByDay[sel] || [])
                    .map((x, k) => {
                      const it = byId(x.intern);
                      const p = postById(x.post);
                      if (!p) return null;
                      const weekly = p.cadence === "semaine";
                      const editIdx = weekly ? weekAnchor(cur.days, sel) : sel;
                      const okey = safeMonth + "-" + editIdx + "-" + x.post;
                      const ov = overrides[okey];
                      const selVal = ov === undefined ? "auto" : (ov === "" ? "" : String(ov));
                      const isOffered = offers.some((o) => o.monthIdx === safeMonth && o.dIdx === editIdx && o.postId === x.post);
                      const badHab = it && !p.requires.every((t) => it.tags.includes(t));
                      return (
                        <div key={k} style={S.editRow}>
                          <div style={S.editTop}>
                            <span style={S.detailPost}>
                              {p.label}
                              <span style={S.kindTag}>{(p.kind || "garde") === "astreinte" ? "astreinte" : "garde"}{weekly ? " · hebdo" : ""}</span>
                            </span>
                            <span style={S.editTag}>
                              {x.intern && it && (<span style={{ ...S.detailDot, background: it.color }} />)}
                              {it ? it.name : <span style={S.detailEmpty}>non couvert</span>}
                              {x.forced && <span style={S.forcedTag}>manuel</span>}
                            </span>
                          </div>
                          {weekly && <div style={S.weekNote}>Astreinte hebdomadaire — modifier ici réassigne toute la semaine.</div>}
                          <div style={S.editCtrls}>
                            <select
                              value={selVal}
                              onChange={(e) => {
                                const v = e.target.value;
                                setOverride(safeMonth, editIdx, x.post, v === "auto" ? null : (v === "" ? "" : Number(v)));
                              }}
                              style={S.editSelect}
                            >
                              <option value="auto">Auto (algorithme)</option>
                              <option value="">— laisser vide —</option>
                              {interns.map((i) => {
                                const ok = p.requires.every((t) => i.tags.includes(t));
                                return <option key={i.id} value={i.id}>{i.name}{ok ? "" : " (non habilité)"}</option>;
                              })}
                            </select>
                            {x.intern && (
                              isOffered
                                ? <span style={S.offeredTag}>à la bourse</span>
                                : <button style={S.offerBtn} onClick={() => offerShift(safeMonth, editIdx, x.post)}>Échanger</button>
                            )}
                          </div>
                          {badHab && <div style={S.habWarn}>⚠ {it.name} n'a pas l'habilitation requise pour {p.label}</div>}
                        </div>
                      );
                    })}
                </>
              )}
            </div>
          )}

          {/* validation collégiale du mois */}
          <div style={S.votePanel}>
            <div style={S.voteHead}>Validation du mois</div>
            <div style={S.voteHint}>
              Chaque interne se prononce ; {byId(respoOf(safeMonth))?.name || "le responsable"} valide.
            </div>
            <div style={S.voteRow}>
              {interns.map((i) => {
                const v = votes[safeMonth + "-" + i.id];
                return (
                  <button
                    key={i.id}
                    onClick={() => castVote(safeMonth, i.id, v === "pour" ? "contre" : "pour")}
                    style={{
                      ...S.voteChip,
                      ...(v === "pour" ? S.votePour : v === "contre" ? S.voteContre : {}),
                    }}
                  >
                    <span style={{ ...S.voteDot, background: i.color }} />
                    {i.name}
                    {v === "pour" ? " ✓" : v === "contre" ? " ✗" : ""}
                  </button>
                );
              })}
            </div>
            <div style={S.voteFoot}>
              <span style={S.voteTally}>
                {voteTally(safeMonth).pour} pour · {voteTally(safeMonth).contre} contre
              </span>
              <button
                onClick={() => toggleValidated(safeMonth)}
                style={{ ...S.validateBtn, ...(validated[safeMonth] ? S.validateBtnOn : {}) }}
              >
                {validated[safeMonth] ? "Annuler la validation" : "Valider le mois"}
              </button>
            </div>
          </div>
          </>
          )}
        </section>
      )}

      {/* ---------------- BOURSE ---------------- */}
      {tab === "bourse" && (
        <section style={S.body}>
          <div style={S.semIntro}>
            Bourse aux astreintes : propose une astreinte à l'échange (depuis l'onglet Mois,
            bouton « Échanger »), puis attribue-la ici à un remplaçant.
          </div>
          {offers.length === 0 ? (
            <div style={S.emptyBourse}>
              Aucune astreinte proposée pour l'instant. Dans l'onglet Mois, touche un jour
              puis « Échanger » sur l'astreinte concernée.
            </div>
          ) : (
            offers.map((o) => {
              const m = sem[o.monthIdx];
              const day = m && m.days[o.dIdx];
              const p = postById(o.postId);
              const fromI = byId(o.from);
              if (!day || !p) return null;
              const elig = interns.filter(
                (i) => i.id !== o.from && p.requires.every((t) => i.tags.includes(t))
              );
              return (
                <div key={o.id} style={S.offerCard}>
                  <div style={S.offerTop}>
                    <div>
                      <div style={S.offerWhen}>{m.name} {day.date} · {p.label}</div>
                      <div style={S.offerFrom}>
                        cédée par
                        <span style={{ ...S.detailDot, background: fromI?.color, margin: "0 4px" }} />
                        {fromI?.name}
                      </div>
                    </div>
                    <button style={S.offerCancel} onClick={() => cancelOffer(o.id)}>✕</button>
                  </div>
                  <div style={S.offerTake}>
                    <span style={S.offerTakeLabel}>Attribuer à :</span>
                    <div style={S.offerChips}>
                      {elig.length === 0 ? (
                        <span style={S.detailEmpty}>aucun remplaçant habilité</span>
                      ) : (
                        elig.map((i) => (
                          <button key={i.id} style={S.takeChip} onClick={() => takeOffer(o, i.id)}>
                            <span style={{ ...S.voteDot, background: i.color }} />
                            {i.name}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}

      {/* ---------------- SEMESTRE ---------------- */}
      {tab === "semestre" && (
        <section style={S.body}>
          {!valid ? (
            <div style={S.warn}>
              Définis une période d'exercice valide pour voir la synthèse.
            </div>
          ) : (
          <>
          <div style={S.semIntro}>
            L'équité se cumule sur les {months.length} mois de l'exercice : le
            report de chaque mois alimente le suivant pour égaliser la charge.
          </div>

          {/* mini-calendriers */}
          <div style={S.miniScroll}>
            {sem.map((m, mi) => (
              <div key={mi} style={S.miniMonth}>
                <div style={S.miniName}>{m.name}</div>
                <div style={S.miniGrid}>
                  {Array.from({ length: m.start }, (_, b) => (
                    <span key={"b" + b} style={S.miniCell} />
                  ))}
                  {m.days.map((d, di) => {
                    const sp = d.holiday || d.wd === 5 || d.wd === 6;
                    return (
                      <span
                        key={di}
                        style={{
                          ...S.miniCell,
                          background: sp ? "var(--accent)" : "var(--cool)",
                          opacity: sp ? 0.9 : 0.35,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* matrice d'équité interns × mois */}
          <div style={S.matrixWrap}>
            <div style={S.matrixRow}>
              <div style={S.mLabel} />
              {sem.map((m, i) => (
                <div key={i} style={S.mHead}>{m.name.slice(0, 3)}</div>
              ))}
              <div style={S.mTotal}>Σ</div>
            </div>
            {interns
              .slice()
              .sort(
                (a, b) =>
                  sem[sem.length - 1].score[b.id] -
                  sem[sem.length - 1].score[a.id]
              )
              .map((i) => (
                <div key={i.id} style={S.matrixRow}>
                  <div style={{ ...S.mLabel, color: i.color }}>{i.name}</div>
                  {sem.map((m, mi) => {
                    const n = m.count[i.id] || 0;
                    return (
                      <div
                        key={mi}
                        style={{
                          ...S.mCell,
                          background: heatBg(n),
                          color: n / maxMonthCount > 0.45 ? "var(--paper)" : "var(--muted)",
                        }}
                      >
                        {n}
                      </div>
                    );
                  })}
                  <div style={S.mTotal}>
                    {(sem[sem.length - 1].score[i.id] || 0).toFixed(0)}
                  </div>
                </div>
              ))}
          </div>

          <div style={S.spreadCard}>
            <span style={S.spreadNum}>{spread}</span>
            <span style={S.spreadLabel}>
              écart final de charge (max − min)
              <br />
              <span style={S.spreadSub}>plus c'est bas, plus c'est équitable</span>
            </span>
          </div>

          {/* export du planning */}
          <div style={S.exportCard}>
            <div style={S.habTitle}>Exporter le planning</div>
            <div style={S.habHint}>
              Agenda (.ics) à importer dans un calendrier, ou tableau (.csv) ouvrable dans Excel.
            </div>
            <select value={exportWho} onChange={(e) => setExportWho(e.target.value)} style={S.exportSelect}>
              <option value="all">Toutes les personnes</option>
              {interns.map((i) => (<option key={i.id} value={i.id}>{i.name} seulement</option>))}
            </select>
            <div style={S.exportBtns}>
              <button onClick={exportICS} style={S.exportBtn}>Agenda .ics</button>
              <button onClick={exportCSV} style={S.exportBtn}>Tableau .csv</button>
            </div>
          </div>
          </>
          )}
        </section>
      )}

      {/* ---------------- ÉQUIPE ---------------- */}
      {tab === "equipe" && (
        <section style={S.body}>
          {/* gestion des habilitations */}
          <div style={S.habCard}>
            <div style={S.habTitle}>Habilitations</div>
            <div style={S.habHint}>
              Renomme, ajoute ou supprime une habilitation. Les internes et les postes
              se mettent à jour automatiquement.
            </div>
            <div style={S.habList}>
              {tagList.map((t, k) => (
                <div key={k} style={S.habItem}>
                  <input
                    value={t}
                    onChange={(e) => renameTag(t, e.target.value)}
                    style={S.habInput}
                  />
                  <button onClick={() => removeTag(t)} style={S.habDel}>✕</button>
                </div>
              ))}
            </div>
            <button onClick={addTag} style={S.addBtn}>+ Ajouter une habilitation</button>
          </div>

          <div style={S.teamHint}>
            Édite l'équipe : touche le nom pour le changer, règle le report,
            coche les habilitations. Tout se recalcule en direct.
          </div>
          {interns.map((i) => (
            <div key={i.id} style={S.internCard}>
              <div style={S.internTop}>
                <div style={{ ...S.avatar, background: i.color }}>
                  {(i.name[0] || "?").toUpperCase()}
                </div>
                <input
                  value={i.name}
                  onChange={(e) => renameIntern(i.id, e.target.value)}
                  style={S.nameInput}
                />
                <button onClick={() => removeIntern(i.id)} style={S.del}>✕</button>
              </div>

              <div style={S.carryRow}>
                <span style={S.carryLabel}>Report</span>
                <button onClick={() => bumpCarry(i.id, -1)} style={S.step}>−</button>
                <span style={S.carryVal}>{i.carry}</span>
                <button onClick={() => bumpCarry(i.id, 1)} style={S.step}>+</button>
              </div>

              <div style={S.tagRow}>
                {tagList.map((t) => {
                  const on = i.tags.includes(t);
                  return (
                    <button
                      key={t}
                      onClick={() => toggleTag(i.id, t)}
                      style={{ ...S.tag, ...(on ? S.tagOn : {}) }}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <button onClick={addIntern} style={S.addBtn}>+ Ajouter un interne</button>
        </section>
      )}

      {/* ---------------- POSTES ---------------- */}
      {tab === "postes" && (
        <section style={S.body}>
          {/* pondération de pénibilité par type de jour */}
          <div style={S.habCard}>
            <div style={S.habTitle}>Pondération des jours</div>
            <div style={S.habHint}>
              Combien « pèse » une garde selon le jour, pour le calcul d'équité.
              Un dimanche ou un férié plus lourd sera réparti plus équitablement.
            </div>
            <div style={S.wGrid}>
              {[["week", "Semaine"], ["sat", "Samedi"], ["sun", "Dimanche"], ["holiday", "Férié"]].map(([k, l]) => (
                <div key={k} style={S.wItem}>
                  <span style={S.wLabel}>{l}</span>
                  <input
                    type="number" step="0.1" min="0"
                    value={weights[k]}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      setWeights((w) => ({ ...w, [k]: isNaN(v) ? 0 : v }));
                    }}
                    style={S.wInput}
                  />
                </div>
              ))}
            </div>
            <button onClick={() => setWeights(DEFAULT_WEIGHTS)} style={S.wReset}>Valeurs par défaut</button>
          </div>

          <div style={S.teamHint}>
            Définis les créneaux à couvrir chaque jour et les habilitations
            requises. Sans tag requis, le poste est ouvert à tout le monde.
          </div>
          {posts.map((p) => {
            const eligibleCount = interns.filter((i) =>
              p.requires.every((t) => i.tags.includes(t))
            ).length;
            return (
              <div key={p.id} style={S.internCard}>
                <div style={S.internTop}>
                  <input
                    value={p.label}
                    onChange={(e) => renamePost(p.id, e.target.value)}
                    style={S.nameInput}
                  />
                  <button onClick={() => removePost(p.id)} style={S.del}>✕</button>
                </div>

                <div style={S.segLabel}>Type</div>
                <div style={S.seg}>
                  {[["garde", "Garde"], ["astreinte", "Astreinte"]].map(([v, l]) => (
                    <button key={v} onClick={() => setPostField(p.id, "kind", v)}
                      style={{ ...S.segBtn, ...((p.kind || "garde") === v ? S.segOn : {}) }}>{l}</button>
                  ))}
                </div>
                <div style={S.segLabel}>Cadence</div>
                <div style={S.seg}>
                  {[["jour", "Journalière"], ["semaine", "Hebdomadaire"]].map(([v, l]) => (
                    <button key={v} onClick={() => setPostField(p.id, "cadence", v)}
                      style={{ ...S.segBtn, ...((p.cadence || "jour") === v ? S.segOn : {}) }}>{l}</button>
                  ))}
                </div>

                <div style={S.reqLabel}>Habilitations requises</div>
                <div style={S.tagRow}>
                  {tagList.map((t) => {
                    const on = p.requires.includes(t);
                    return (
                      <button
                        key={t}
                        onClick={() => togglePostTag(p.id, t)}
                        style={{ ...S.tag, ...(on ? S.tagOn : {}) }}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
                <div
                  style={{
                    ...S.eligNote,
                    color: eligibleCount === 0 ? "var(--hot)" : "var(--muted)",
                  }}
                >
                  {eligibleCount === 0
                    ? "⚠ personne n'est habilité — créneau non couvrable"
                    : eligibleCount + " interne" + (eligibleCount > 1 ? "s" : "") + " éligible" + (eligibleCount > 1 ? "s" : "")}
                </div>
              </div>
            );
          })}
          <button onClick={addPost} style={S.addBtn}>+ Ajouter un poste</button>
        </section>
      )}

      {/* Équité cumulée — aide à la planification, placée en bas */}
      {cur && (
      <section style={S.equityCard}>
        <div style={S.equityTitle}>
          Charge cumulée <span style={S.equityHint}>cumul jusqu'à {cur.name} inclus</span>
        </div>
        {interns
          .slice()
          .sort((a, b) => cur.score[b.id] - cur.score[a.id])
          .map((i) => {
            const sc = cur.score[i.id] || 0;
            const pct = (sc / maxScore) * 100;
            return (
              <div key={i.id} style={S.barRow}>
                <div style={S.barName}>{i.name}</div>
                <div style={S.barTrack}>
                  <div
                    style={{
                      ...S.barFill,
                      width: pct + "%",
                      background: i.color,
                    }}
                  />
                </div>
                <div style={S.barScore}>{sc.toFixed(1)}</div>
              </div>
            );
          })}
        <div style={S.equityFoot}>
          Repère pour planifier : assigne en priorité les barres les plus courtes.
        </div>
      </section>
      )}

      <footer style={S.footer}>
        <button onClick={resetAll} style={S.resetBtn}>Réinitialiser les données</button>
        <div style={S.footNote}>Version perso · enregistré automatiquement sur ton appareil</div>
      </footer>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Spline+Sans+Mono:wght@400;500;600&display=swap');
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
body { margin: 0; }
:root{
  --paper:#0e1116; --panel:#161b22; --panel2:#1c232d;
  --ink:#f4ede4; --muted:#8a93a0; --line:#2a323d;
  --cool:#3fb6a8; --mid:#e0a13c; --hot:#e0613c; --accent:#f0c987;
}
.rota-light{
  --paper:#f6f4ee; --panel:#ffffff; --panel2:#efece3;
  --ink:#1f2328; --muted:#6b7280; --line:#e0dccf;
  --cool:#2f9488; --mid:#bb801f; --hot:#cf532b; --accent:#b6892f;
}
input, select, textarea { color-scheme: dark; }
.rota-light input, .rota-light select, .rota-light textarea { color-scheme: light; }
.miniscroll::-webkit-scrollbar{height:0;}
`;

const mono = "'Spline Sans Mono', monospace";
const display = "'Fraunces', serif";

const S = {
  shell: { maxWidth: 430, margin: "0 auto", minHeight: "100vh", background: "var(--paper)", color: "var(--ink)", fontFamily: mono, paddingBottom: 40 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 18px 14px" },
  logoRow: { display: "flex", alignItems: "center", gap: 12 },
  logoMark: { width: 40, height: 40, borderRadius: 12, background: "var(--accent)", color: "var(--paper)", display: "grid", placeItems: "center", fontSize: 22, fontWeight: 700 },
  appName: { fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: 1, lineHeight: 1 },
  appSub: { fontSize: 11, color: "var(--muted)", marginTop: 3 },
  monthBadge: { fontSize: 11, color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 20, padding: "6px 12px" },
  monthSelect: { fontSize: 12, color: "var(--ink)", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 20, padding: "6px 10px", fontFamily: mono },
  headRight: { display: "flex", alignItems: "center", gap: 8 },
  themeBtn: { width: 34, height: 34, borderRadius: 10, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--ink)", fontSize: 15, cursor: "pointer", lineHeight: 1 },

  exerciseBar: { display: "flex", alignItems: "center", gap: 8, margin: "0 14px 4px", padding: "10px 12px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14 },
  exLabel: { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginRight: 2 },
  exArrow: { color: "var(--muted)", fontSize: 13 },
  dateInput: { flex: 1, minWidth: 0, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 9, color: "var(--ink)", fontFamily: mono, fontSize: 12, padding: "7px 8px" },
  warn: { background: "var(--panel)", border: "1px solid var(--hot)", borderRadius: 14, padding: 16, fontSize: 12.5, color: "var(--ink)", lineHeight: 1.5 },

  equityCard: { margin: "26px 14px 0", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 18, padding: "16px 16px 14px" },
  equityFoot: { fontSize: 10.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 6, borderTop: "1px solid var(--line)", paddingTop: 9 },
  equityTitle: { fontFamily: display, fontSize: 17, fontWeight: 600, marginBottom: 12 },
  equityHint: { fontFamily: mono, fontSize: 10.5, color: "var(--muted)", fontWeight: 400 },
  barRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  barName: { width: 64, fontSize: 12.5 },
  barTrack: { flex: 1, height: 10, background: "var(--panel2)", borderRadius: 6, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 6, transition: "width .4s ease" },
  barScore: { width: 34, textAlign: "right", fontSize: 12, color: "var(--muted)" },

  tabs: { display: "flex", gap: 8, padding: "16px 14px 4px", overflowX: "auto", WebkitOverflowScrolling: "touch" },
  tab: { flexShrink: 0, padding: "11px 14px", background: "transparent", border: "1px solid var(--line)", borderRadius: 12, color: "var(--muted)", fontFamily: mono, fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" },
  tabActive: { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" },

  body: { padding: "12px 14px 0" },

  monthNav: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
  navArrow: { width: 40, height: 40, borderRadius: 12, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--ink)", fontSize: 22, lineHeight: 1, cursor: "pointer", flexShrink: 0 },
  navArrowOff: { opacity: 0.3, cursor: "default" },
  monthTitle: { flex: 1, textAlign: "center" },
  monthTitleName: { display: "block", fontFamily: display, fontSize: 22, fontWeight: 900, letterSpacing: 0.5 },
  monthTitleSub: { display: "block", fontSize: 10.5, color: "var(--muted)", marginTop: 2 },

  modeRow: { display: "flex", gap: 6, marginBottom: 12, background: "var(--panel2)", padding: 4, borderRadius: 12 },
  modeBtn: { flex: 1, padding: "9px 0", background: "transparent", border: "none", borderRadius: 9, color: "var(--muted)", fontFamily: mono, fontSize: 12.5, fontWeight: 500, cursor: "pointer" },
  modeBtnOn: { background: "var(--panel)", color: "var(--ink)", boxShadow: "0 1px 4px rgba(0,0,0,.3)" },
  personPick: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  personChip: { padding: "6px 11px", borderRadius: 20, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontFamily: mono, fontSize: 12, cursor: "pointer" },
  legendNote: { fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 },
  offMark: { fontSize: 9, color: "var(--paper)", fontWeight: 600, paddingBottom: 6, letterSpacing: 1 },

  legend: { display: "flex", gap: 14, marginBottom: 12, flexWrap: "wrap" },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--muted)" },
  legendDot: { width: 9, height: 9, borderRadius: "50%" },

  weekHead: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 5 },
  weekHeadCell: { textAlign: "center", fontSize: 10, color: "var(--muted)", letterSpacing: 1 },
  grid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 },
  blank: { aspectRatio: "1 / 1.15" },
  cell: { aspectRatio: "1 / 1.15", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 9, padding: "4px 0 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontFamily: mono },
  cellSpecial: { background: "var(--panel2)", borderColor: "rgba(240,201,135,.35)" },
  cellSel: { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" },
  cellOut: { background: "transparent", border: "1px dashed var(--line)", opacity: 0.4, cursor: "default" },
  cellNumOut: { fontSize: 11, color: "var(--muted)" },
  cellNum: { fontSize: 12, color: "var(--ink)", fontWeight: 500 },
  dots: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 3, paddingBottom: 6 },
  dot: { width: 7, height: 7, borderRadius: "50%", boxSizing: "border-box" },

  detail: { marginTop: 14, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 14, minHeight: 70 },
  detailHint: { fontSize: 12, color: "var(--muted)", lineHeight: 1.5 },
  detailHead: { fontFamily: display, fontSize: 16, fontWeight: 600, marginBottom: 10 },
  detailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--line)" },
  detailPost: { fontSize: 12.5, color: "var(--muted)" },
  detailName: { fontSize: 13.5, fontWeight: 500, display: "flex", alignItems: "center", gap: 7 },
  detailDot: { width: 9, height: 9, borderRadius: "50%" },
  detailEmpty: { fontSize: 13, fontStyle: "italic", color: "var(--hot)" },

  semIntro: { fontSize: 12, color: "var(--muted)", lineHeight: 1.55, marginBottom: 14 },
  miniScroll: { display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6, marginBottom: 18 },
  miniMonth: { flex: "0 0 auto" },
  miniName: { fontSize: 10.5, color: "var(--muted)", marginBottom: 5, textAlign: "center", letterSpacing: 1, textTransform: "uppercase" },
  miniGrid: { display: "grid", gridTemplateColumns: "repeat(7,9px)", gap: 2 },
  miniCell: { width: 9, height: 9, borderRadius: 2 },

  matrixWrap: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 12, marginBottom: 16 },
  matrixRow: { display: "flex", alignItems: "center", gap: 4, marginBottom: 4 },
  mLabel: { width: 60, fontSize: 11.5, color: "var(--ink)", flexShrink: 0 },
  mHead: { flex: 1, textAlign: "center", fontSize: 10, color: "var(--muted)", textTransform: "uppercase" },
  mCell: { flex: 1, textAlign: "center", fontSize: 11.5, padding: "5px 0", borderRadius: 5, fontWeight: 500 },
  mTotal: { width: 34, textAlign: "center", fontSize: 12.5, fontWeight: 600, color: "var(--accent)", flexShrink: 0 },

  spreadCard: { display: "flex", alignItems: "center", gap: 14, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 14, padding: "14px 16px" },
  spreadNum: { fontFamily: display, fontSize: 34, fontWeight: 900, color: "var(--cool)", lineHeight: 1 },
  spreadLabel: { fontSize: 12, color: "var(--ink)", lineHeight: 1.4 },
  spreadSub: { fontSize: 10.5, color: "var(--muted)" },
  exportCard: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 14, marginTop: 16 },
  exportSelect: { width: "100%", background: "var(--panel2)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 9, fontFamily: mono, fontSize: 12.5, padding: "9px 10px", marginBottom: 10 },
  exportBtns: { display: "flex", gap: 8 },
  exportBtn: { flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid var(--cool)", background: "transparent", color: "var(--cool)", fontFamily: mono, fontSize: 13, fontWeight: 600, cursor: "pointer" },

  teamHint: { fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5, marginBottom: 14 },
  habCard: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 14, marginBottom: 16 },
  habTitle: { fontFamily: display, fontSize: 16, fontWeight: 600, marginBottom: 3 },
  habHint: { fontSize: 11, color: "var(--muted)", lineHeight: 1.45, marginBottom: 11 },
  habList: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 11 },
  habItem: { display: "flex", alignItems: "center", gap: 4, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 20, padding: "2px 4px 2px 10px" },
  habInput: { width: 86, background: "transparent", border: "none", color: "var(--ink)", fontFamily: mono, fontSize: 12.5, padding: "5px 0", outline: "none" },
  habDel: { width: 22, height: 22, borderRadius: "50%", border: "none", background: "transparent", color: "var(--muted)", fontSize: 11, cursor: "pointer" },
  wGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 11 },
  wItem: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px" },
  wLabel: { fontSize: 12.5, color: "var(--ink)" },
  wInput: { width: 56, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--accent)", fontFamily: mono, fontSize: 13, fontWeight: 600, textAlign: "center", padding: "6px 4px" },
  wReset: { background: "transparent", border: "1px solid var(--line)", borderRadius: 10, color: "var(--muted)", fontFamily: mono, fontSize: 11.5, padding: "7px 12px", cursor: "pointer" },
  internCard: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 13, marginBottom: 9 },
  internTop: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 },
  avatar: { width: 30, height: 30, borderRadius: 9, background: "var(--accent)", color: "var(--paper)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14 },
  internName: { fontSize: 14, fontWeight: 500, flex: 1 },
  nameInput: { flex: 1, background: "transparent", border: "none", borderBottom: "1px solid var(--line)", color: "var(--ink)", fontFamily: mono, fontSize: 14, fontWeight: 500, padding: "3px 2px", outline: "none" },
  del: { width: 26, height: 26, borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer", flexShrink: 0 },
  carryRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 11 },
  carryLabel: { fontSize: 11.5, color: "var(--muted)", flex: 1 },
  step: { width: 28, height: 28, borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--ink)", fontSize: 16, lineHeight: 1, cursor: "pointer" },
  carryVal: { minWidth: 22, textAlign: "center", fontSize: 14, fontWeight: 600 },
  addBtn: { width: "100%", padding: "13px 0", marginTop: 4, borderRadius: 14, border: "1.5px dashed var(--line)", background: "transparent", color: "var(--accent)", fontFamily: mono, fontSize: 13, fontWeight: 500, cursor: "pointer" },
  tagRow: { display: "flex", flexWrap: "wrap", gap: 7 },
  reqLabel: { fontSize: 11, color: "var(--muted)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 },
  segLabel: { fontSize: 11, color: "var(--muted)", margin: "10px 0 6px", textTransform: "uppercase", letterSpacing: 0.5 },
  seg: { display: "flex", gap: 6, background: "var(--panel2)", padding: 4, borderRadius: 10 },
  segBtn: { flex: 1, padding: "8px 0", background: "transparent", border: "none", borderRadius: 7, color: "var(--muted)", fontFamily: mono, fontSize: 12, cursor: "pointer" },
  segOn: { background: "var(--ink)", color: "var(--paper)", fontWeight: 600 },
  kindTag: { fontSize: 9.5, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 10, padding: "1px 6px", marginLeft: 7, textTransform: "uppercase", letterSpacing: 0.5 },
  weekNote: { fontSize: 10.5, color: "var(--muted)", marginBottom: 8, fontStyle: "italic" },
  eligNote: { fontSize: 11, marginTop: 10, lineHeight: 1.4 },
  tag: { padding: "6px 12px", borderRadius: 20, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontFamily: mono, fontSize: 12, cursor: "pointer" },
  tagOn: { background: "var(--cool)", color: "var(--paper)", borderColor: "var(--cool)", fontWeight: 600 },

  respoBar: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, padding: "9px 12px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12 },
  respoLeft: { display: "flex", alignItems: "center", gap: 8 },
  respoLabel: { fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 },
  respoSelect: { background: "var(--panel2)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 8, fontFamily: mono, fontSize: 12.5, padding: "5px 8px" },
  statut: { fontSize: 11.5, color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 20, padding: "4px 10px" },
  statutOk: { color: "var(--paper)", background: "var(--cool)", borderColor: "var(--cool)", fontWeight: 600 },

  editRow: { padding: "10px 0", borderTop: "1px solid var(--line)" },
  editTop: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  editTag: { fontSize: 13.5, fontWeight: 500, display: "flex", alignItems: "center", gap: 7 },
  forcedTag: { fontSize: 9.5, color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 10, padding: "1px 6px", marginLeft: 4 },
  editCtrls: { display: "flex", gap: 8, alignItems: "center" },
  editSelect: { flex: 1, minWidth: 0, background: "var(--panel2)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 9, fontFamily: mono, fontSize: 12.5, padding: "8px" },
  offerBtn: { flexShrink: 0, background: "transparent", color: "var(--accent)", border: "1px solid var(--accent)", borderRadius: 9, fontFamily: mono, fontSize: 12, padding: "8px 12px", cursor: "pointer" },
  offeredTag: { flexShrink: 0, fontSize: 11, color: "var(--muted)", fontStyle: "italic" },
  habWarn: { fontSize: 10.5, color: "var(--hot)", marginTop: 6 },

  votePanel: { marginTop: 14, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 14 },
  voteHead: { fontFamily: display, fontSize: 16, fontWeight: 600, marginBottom: 3 },
  voteHint: { fontSize: 11, color: "var(--muted)", marginBottom: 11, lineHeight: 1.45 },
  voteRow: { display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 12 },
  voteChip: { display: "flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 20, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontFamily: mono, fontSize: 12, cursor: "pointer" },
  votePour: { borderColor: "var(--cool)", color: "var(--cool)" },
  voteContre: { borderColor: "var(--hot)", color: "var(--hot)" },
  voteDot: { width: 8, height: 8, borderRadius: "50%" },
  voteFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid var(--line)", paddingTop: 11 },
  voteTally: { fontSize: 12, color: "var(--muted)" },
  validateBtn: { background: "var(--ink)", color: "var(--paper)", border: "none", borderRadius: 10, fontFamily: mono, fontSize: 12.5, fontWeight: 600, padding: "9px 14px", cursor: "pointer" },
  validateBtnOn: { background: "var(--cool)" },

  emptyBourse: { background: "var(--panel)", border: "1px dashed var(--line)", borderRadius: 14, padding: 18, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 },
  offerCard: { background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: 13, marginBottom: 10 },
  offerTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 },
  offerWhen: { fontFamily: display, fontSize: 15, fontWeight: 600 },
  offerFrom: { fontSize: 11.5, color: "var(--muted)", display: "flex", alignItems: "center", marginTop: 3 },
  offerCancel: { width: 26, height: 26, borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer", flexShrink: 0 },
  offerTake: { borderTop: "1px solid var(--line)", paddingTop: 10 },
  offerTakeLabel: { fontSize: 11.5, color: "var(--muted)", display: "block", marginBottom: 7 },
  offerChips: { display: "flex", flexWrap: "wrap", gap: 7 },
  takeChip: { display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 20, border: "1px solid var(--cool)", background: "transparent", color: "var(--cool)", fontFamily: mono, fontSize: 12, fontWeight: 500, cursor: "pointer" },

  footer: { textAlign: "center", marginTop: 22, padding: "0 20px 10px", lineHeight: 1.5 },
  resetBtn: { background: "transparent", border: "1px solid var(--line)", borderRadius: 10, color: "var(--muted)", fontFamily: mono, fontSize: 11.5, padding: "8px 16px", cursor: "pointer" },
  footNote: { fontSize: 10, color: "var(--muted)", marginTop: 10 },
  splash: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, minHeight: "70vh" },
  splashText: { fontSize: 12, color: "var(--muted)" },
};
