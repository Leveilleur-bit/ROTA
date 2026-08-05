import React, { useState, useMemo, useEffect, useRef } from "react";
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
const DOW_NAMES = {
  fr: ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"],
  en: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
};
const DOW = DOW_NAMES.fr; // défaut (usages hors composant)
// Couleur de texte lisible (sombre ou clair) selon la luminance d'un fond.
function textOn(hex) {
  const h = String(hex).replace("#", "");
  if (h.length < 6) return "#0e1116";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.62 ? "#0e1116" : "#f4ede4";
}
const MONTH_NAMES = {
  fr: ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};

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
    months.push({ year: y, monthIdx: m, name: MONTH_NAMES.fr[m], len, start: firstWd, days });
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

// Génère tout l'exercice sur une timeline CONTINUE (les jours s'enchaînent d'un
// mois à l'autre), pour que le repos de sécurité et les semaines d'astreinte
// franchissent correctement les frontières de mois. Le résultat est redécoupé
// par mois pour l'affichage, avec un instantané de charge cumulée par mois.
function simulateSemester(interns, posts, unavail, months, overrides, weights) {
  const W = weights || DEFAULT_WEIGHTS;
  const score = {};
  interns.forEach((i) => (score[i.id] = i.carry || 0));
  const has = (id) => interns.some((i) => i.id === id);
  const ov = (k) => (overrides ? overrides[k] : undefined);

  // timeline plate : chaque entrée = { mi, dIdx, day } dans l'ordre chronologique
  const flat = [];
  months.forEach((m, mi) => m.days.forEach((day, dIdx) => flat.push({ mi, dIdx, day })));
  const N = flat.length;
  const takenDay = flat.map(() => new Set());
  const lastGarde = {}; // interne → index global de sa dernière garde journalière
  const dayAssign = {}; // "mi-dIdx-postId" → internId | null
  const forcedAt = {};
  const monthCount = months.map(() => { const o = {}; interns.forEach((i) => (o[i.id] = 0)); return o; });
  const snap = months.map(() => null); // instantané de charge cumulée par mois

  const inR = (g) => flat[g].day.inRange !== false;
  const wOf = (g) => weightOf(flat[g].day, W);
  const keyOf = (g, postId) => flat[g].mi + "-" + flat[g].dIdx + "-" + postId;
  const unav = (id, g) => unavail && unavail[flat[g].mi + "-" + id + "-" + flat[g].dIdx];

  // indices (dans la période) de la semaine lun→dim contenant g, à travers les mois
  function weekIdxs(g) {
    let s = g;
    while (s > 0 && flat[s].day.wd !== 0) s--;
    let e = s;
    while (e + 1 < N && flat[e + 1].day.wd !== 0) e++;
    const out = [];
    for (let i = s; i <= e; i++) if (inR(i)) out.push(i);
    return out;
  }

  const inRangeIdx = [];
  for (let g = 0; g < N; g++) if (inR(g)) inRangeIdx.push(g);

  // Un poste "période" (bloc de N jours ou semaine) : une personne couvre tout un
  // groupe de jours. On précalcule les groupes et, pour chaque jour, son ancre
  // (1er jour du groupe) — clé où vit la surcharge manuelle.
  function periodSpan(post) {
    return post.cadence === "semaine" ? "semaine" : Math.max(1, Math.round(post.span || 1));
  }
  const isWeekend = (g) => flat[g].day.wd === 5 || flat[g].day.wd === 6;
  const isPeriod = (post) =>
    post.cadence === "semaine" || post.cadence === "we" || post.cadence === "sem5" || (post.cadence === "bloc" && periodSpan(post) >= 2);
  // un poste "week-end" n'existe que sam/dim ; un poste "sem5" n'existe qu'en semaine (lun→ven)
  const appliesOn = (post, day) =>
    post.cadence === "we" ? (day.wd === 5 || day.wd === 6)
    : post.cadence === "sem5" ? (day.wd <= 4)
    : true;

  const groupsByPost = {};
  posts.filter(isPeriod).forEach((post) => {
    let groups = [];
    if (post.cadence === "semaine") {
      const seen = new Set();
      inRangeIdx.forEach((g) => {
        const wk = weekIdxs(g);
        if (wk.length && !seen.has(wk[0])) { seen.add(wk[0]); groups.push(wk); }
      });
    } else if (post.cadence === "we") {
      // regrouper chaque week-end (samedi+dimanche contigus)
      let curG = [];
      const flush = () => { if (curG.length) { groups.push(curG); curG = []; } };
      inRangeIdx.forEach((g) => {
        if (isWeekend(g)) {
          if (curG.length && g !== curG[curG.length - 1] + 1) flush();
          curG.push(g);
        } else flush();
      });
      flush();
    } else if (post.cadence === "sem5") {
      // regrouper les jours ouvrés (lun→ven) de chaque semaine ; le week-end coupe
      let curG = [];
      const flush = () => { if (curG.length) { groups.push(curG); curG = []; } };
      inRangeIdx.forEach((g) => {
        if (!isWeekend(g)) {
          if (curG.length && g !== curG[curG.length - 1] + 1) flush();
          curG.push(g);
        } else flush();
      });
      flush();
    } else {
      const n = periodSpan(post);
      for (let i = 0; i < inRangeIdx.length; i += n) groups.push(inRangeIdx.slice(i, i + n));
    }
    const anchorOf = {}, members = {};
    groups.forEach((gr) => { members[gr[0]] = gr; gr.forEach((idx) => (anchorOf[idx] = gr[0])); });
    groupsByPost[post.id] = { anchorOf, members };
  });

  const anchorMeta = {}; // "mi-dIdx-postId" → { mi, dIdx } de l'ancre du groupe
  const periodPosts = posts.filter(isPeriod);
  const dailyPosts = posts.filter((p) => !isPeriod(p));

  for (let g = 0; g < N; g++) {
    if (inR(g)) {
      // 1) postes "période" (bloc / semaine) : traités une fois, à l'ancre du groupe
      periodPosts.forEach((post) => {
        const gm = groupsByPost[post.id];
        if (gm.anchorOf[g] !== g) return; // seulement à l'ancre
        const grp = gm.members[g];
        const ww = grp.reduce((s, i) => s + wOf(i), 0);
        const okey = ov(keyOf(g, post.id)); // surcharge lue à l'ancre
        let chosenId = null, forced = false;
        if (okey !== undefined && okey !== null) {
          forced = true;
          chosenId = okey !== "" && has(okey) ? okey : null;
        } else {
          const elig = interns
            .filter((i) => post.requires.every((t) => i.tags.includes(t)))
            .filter((i) => !grp.some((d) => takenDay[d].has(i.id)))
            .filter((i) => !grp.some((d) => unav(i.id, d)))
            .sort((a, b) => score[a.id] - score[b.id]);
          chosenId = elig[0] ? elig[0].id : null;
        }
        if (chosenId) { score[chosenId] += ww; monthCount[flat[g].mi][chosenId] += 1; }
        grp.forEach((d) => {
          dayAssign[keyOf(d, post.id)] = chosenId;
          anchorMeta[keyOf(d, post.id)] = { mi: flat[g].mi, dIdx: flat[g].dIdx };
          if (forced) forcedAt[keyOf(d, post.id)] = true;
          if (chosenId) takenDay[d].add(chosenId);
        });
      });

      // 2) postes journaliers (repos "pas la veille" pour les gardes, à travers les mois)
      const w = wOf(g);
      dailyPosts.forEach((post) => {
        const okey = ov(keyOf(g, post.id));
        if (okey !== undefined && okey !== null) {
          const id = okey !== "" && has(okey) ? okey : null;
          if (id) { score[id] += w; monthCount[flat[g].mi][id]++; takenDay[g].add(id); if (post.kind === "garde") lastGarde[id] = g; }
          dayAssign[keyOf(g, post.id)] = id; forcedAt[keyOf(g, post.id)] = true;
          return;
        }
        const elig = interns
          .filter((i) => post.requires.every((t) => i.tags.includes(t)))
          .filter((i) => post.kind !== "garde" || lastGarde[i.id] !== g - 1)
          .filter((i) => !takenDay[g].has(i.id))
          .filter((i) => !unav(i.id, g))
          .sort((a, b) => score[a.id] - score[b.id]);
        const chosen = elig[0];
        if (chosen) {
          score[chosen.id] += w; monthCount[flat[g].mi][chosen.id]++; takenDay[g].add(chosen.id);
          if (post.kind === "garde") lastGarde[chosen.id] = g;
          dayAssign[keyOf(g, post.id)] = chosen.id;
        } else dayAssign[keyOf(g, post.id)] = null;
      });
    }
    // instantané de charge à la fin de chaque mois
    if (g === N - 1 || flat[g + 1].mi !== flat[g].mi) snap[flat[g].mi] = { ...score };
  }

  // 3) redécoupage par mois pour l'affichage (avec l'ancre du groupe pour l'édition)
  return months.map((m, mi) => {
    const assignments = [];
    m.days.forEach((day, dIdx) => {
      if (day.inRange === false) return;
      posts.forEach((post) => {
        if (!appliesOn(post, day)) return;
        const k = mi + "-" + dIdx + "-" + post.id;
        const anc = anchorMeta[k] || { mi, dIdx };
        assignments.push({ dIdx, post: post.id, intern: dayAssign[k] ?? null, forced: !!forcedAt[k], anchorMi: anc.mi, anchorDIdx: anc.dIdx });
      });
    });
    return { ...m, assignments, score: snap[mi] || { ...score }, count: monthCount[mi] };
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

// Petit champ : créer une habilitation (tag) à la volée depuis un poste.
function NewHabInput({ placeholder, onAdd }) {
  const [v, setV] = useState("");
  const submit = () => { const n = v.trim(); if (n) { onAdd(n); setV(""); } };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
      <input
        value={v}
        placeholder={placeholder}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        style={{ flex: 1, background: "var(--panel2)", border: "1px dashed var(--line)", borderRadius: 8, color: "var(--ink)", fontFamily: "'Spline Sans Mono', monospace", fontSize: 12, padding: "7px 9px" }}
      />
      <button
        onClick={submit}
        style={{ background: "transparent", border: "1px solid var(--cool)", color: "var(--cool)", borderRadius: 8, fontFamily: "'Spline Sans Mono', monospace", fontSize: 16, lineHeight: 1, padding: "0 12px", cursor: "pointer" }}
      >
        +
      </button>
    </div>
  );
}

// Dictionnaire de traduction FR / EN.
const TR = {
  fr: {
    appSub: "astreintes équitables · perso",
    exercise: "Exercice", durationAria: "Durée de l'exercice", months: "mois", days: "jours",
    themeAria: "Changer de thème", langAria: "Langue",
    tMois: "Mois", tBourse: "Bourse", tSemestre: "Semestre", tStats: "Stats", tEquipe: "Équipe", tPostes: "Postes", tPlanning: "Planning",
    undo: "↶ Annuler", redo: "Rétablir ↷",
    responsable: "Responsable", validated: "✓ Validé", brouillon: "Brouillon",
    planifier: "Planifier", indispos: "Indispos",
    tapDay: "Touche un jour pour voir et modifier les astreintes.",
    validationTitle: "Validation du mois", each: "Chaque personne se prononce ;", validates: "valide.",
    pour: "pour", contre: "contre", validerMois: "Valider le mois", annulerValidation: "Annuler la validation",
    auto: "Auto (algorithme)", leaveEmpty: "— laisser vide —", notQualified: " (non habilité)",
    manual: "manuel", uncovered: "non couvert", weeklyNote: "Astreinte hebdomadaire — modifier ici réassigne toute la semaine.",
    swap: "Échanger", listed: "à la bourse", assignTo: "Attribuer à :", noReplacement: "aucun remplaçant habilité",
    bourseEmpty: "Aucune garde proposée à l'échange pour l'instant.",
    spreadLabel: "écart final de charge (max − min)", spreadSub: "plus c'est bas, plus c'est équitable",
    cumLoad: "Charge cumulée", cumUpTo: "cumul jusqu'à", wholePeriod: "sur toute la période", included: "inclus",
    exportTitle: "Exporter le planning",
    exportHint: "Agenda (.ics) à importer dans un calendrier, tableau (.csv) pour Excel, ou impression / PDF.",
    everyone: "Toutes les personnes", only: "seulement", btnIcs: "Agenda .ics", btnCsv: "Tableau .csv",
    btnPdf: "Imprimer / PDF (planning complet)",
    statsHintA: "Récapitulatif sur tout l'exercice (", statsHintB: ") : nombre de gardes/astreintes par personne, dont week-ends et fériés, et charge pondérée cumulée.",
    colPerson: "Personne", colTotal: "Total", colWk: "Sem.", colWE: "WE", colHol: "Fériés", colLoad: "Charge",
    statNote: "« Charge » = somme pondérée (un dimanche ou un férié compte plus qu'un jour de semaine, selon les pondérations). C'est la vraie mesure d'équité, le « Total » n'étant qu'un décompte brut.",
    habTitle: "Habilitations",
    habHint: "Qui peut couvrir quel poste. Coche les habilitations de chaque personne ci-dessous.",
    addHab: "+ Ajouter une habilitation", addIntern: "+ Ajouter un interne", newHab: "Nouvelle habilitation",
    addOne: "Ajouter", defRole: "collaborateur",
    ponderationTitle: "Pondération des jours",
    ponderationHint: "Combien « pèse » une garde selon le jour, pour le calcul d'équité. Un dimanche ou un férié plus lourd sera réparti plus équitablement.",
    wWeek: "Semaine", wSat: "Samedi", wSun: "Dimanche", wHol: "Férié", resetDefaults: "Valeurs par défaut",
    postesHint: "Définis les créneaux à couvrir chaque jour et les habilitations requises. Sans tag requis, le poste est ouvert à tout le monde.",
    typeLabel: "Type", kGarde: "Garde", kAstreinte: "Astreinte",
    cadenceLabel: "Cadence", cadJour: "Journalière", cadSemaine: "Hebdomadaire",
    cadBloc: "Plusieurs jours", cadWe: "Week-end", cadSem5: "Semaine (Lu–Ve)", sem5Short: "Lu–Ve", spanLabel: "Nombre de jours", dayShort: "j",
    periodNote: "Astreinte sur plusieurs jours — modifier ici réassigne tout le bloc.",
    genLive: "à jour", genComputing: "calcul…", roleLabelSetting: "Terme pour les personnes",
    loadOver: "charge sur",
    reqHab: "Habilitations requises", addPoste: "+ Ajouter un poste", newPoste: "Nouveau poste",
    newHabPlaceholder: "Nouvelle habilitation…", assignInTeam: "attribue-la dans l'onglet Équipe",
    eligibleA: "éligible", eligibleP: "éligibles", nobodyElig: "personne n'est habilité — créneau non couvrable", onlyOneA: "seul(e) ", onlyOneB: " peut couvrir ce poste — charge concentrée sur cette personne", fewEligA: "", fewEligB: " seulement peuvent couvrir ce poste — risque de charge concentrée",
    weekly: "hebdo",
    footVersion: "Version perso · enregistré automatiquement sur ton appareil", resetData: "Réinitialiser les données",
    loading: "Chargement…", warnPeriod: "Génère d'abord une période valide.",
    notQualifiedFor: "n'a pas l'habilitation requise pour",
    expDate: "Date", expDay: "Jour", expDayType: "Type jour", expSlot: "Poste", expKind: "Créneau", expPerson: "Interne",
    tHoliday: "Férié", tSat: "Samedi", tSun: "Dimanche", tWeek: "Semaine",
    pdfTitle: "ROTA — Planning", pdfPeriod: "Période :",
    noExport: "L'export n'est pas autorisé dans cet environnement.", noPrint: "L'impression n'est pas autorisée dans cet environnement.",
    dHol: "férié", dWE: "week-end",
    unavailA: "Touche les jours où ", unavailB: " n'est pas disponible. Le planning les évite.",
    semIntroA: "L'équité se cumule sur les ", semIntroB: " mois de l'exercice : le report de chaque mois alimente le suivant pour égaliser la charge.",
    habManageHint: "Renomme, ajoute ou supprime une habilitation. Les personnes et les postes se mettent à jour automatiquement.",
    teamEditHint: "Édite l'équipe : touche le nom pour le changer, règle le report, coche les habilitations. Tout se recalcule en direct.",
    report: "Report",
    bourseIntro: "Bourse aux astreintes : propose une astreinte à l'échange (depuis l'onglet Mois, bouton « Échanger »), puis attribue-la ici à un remplaçant.",
    bourseEmptyFull: "Aucune astreinte proposée pour l'instant. Dans l'onglet Mois, touche un jour puis « Échanger » sur l'astreinte concernée.",
    offerGivenBy: "cédée par", equityFoot: "Repère pour planifier : assigne en priorité les barres les plus courtes.",
    loadingT: "Chargement…", defIntern: "Interne", defPoste: "Nouveau poste", defHab: "Habilitation",
  },
  en: {
    appSub: "fair on-call rota · personal",
    exercise: "Period", durationAria: "Exercise duration", months: "months", days: "days",
    themeAria: "Toggle theme", langAria: "Language",
    tMois: "Month", tBourse: "Swaps", tSemestre: "Overview", tStats: "Stats", tEquipe: "Team", tPostes: "Slots", tPlanning: "Planning",
    undo: "↶ Undo", redo: "Redo ↷",
    responsable: "In charge", validated: "✓ Validated", brouillon: "Draft",
    planifier: "Plan", indispos: "Off days",
    tapDay: "Tap a day to view and edit the on-call assignments.",
    validationTitle: "Month validation", each: "Each member votes;", validates: "validates.",
    pour: "for", contre: "against", validerMois: "Validate month", annulerValidation: "Cancel validation",
    auto: "Auto (algorithm)", leaveEmpty: "— leave empty —", notQualified: " (not qualified)",
    manual: "manual", uncovered: "uncovered", weeklyNote: "Weekly on-call — editing here reassigns the whole week.",
    swap: "Swap", listed: "listed", assignTo: "Assign to:", noReplacement: "no qualified replacement",
    bourseEmpty: "No shift offered for swap yet.",
    spreadLabel: "final load gap (max − min)", spreadSub: "lower is fairer",
    cumLoad: "Cumulative load", cumUpTo: "cumulative through", wholePeriod: "over the whole period", included: "",
    exportTitle: "Export the schedule",
    exportHint: "Calendar (.ics) to import into an agenda, table (.csv) for Excel, or print / PDF.",
    everyone: "Everyone", only: "only", btnIcs: "Calendar .ics", btnCsv: "Table .csv",
    btnPdf: "Print / PDF (full schedule)",
    statsHintA: "Summary over the whole period (", statsHintB: "): number of shifts per person, incl. weekends and holidays, and cumulative weighted load.",
    colPerson: "Person", colTotal: "Total", colWk: "Wk", colWE: "WE", colHol: "Hol.", colLoad: "Load",
    statNote: "\"Load\" = weighted sum (a Sunday or holiday counts more than a weekday, per the weightings). It is the real fairness measure; \"Total\" is only a raw count.",
    habTitle: "Qualifications",
    habHint: "Who can cover which slot. Tick each person's qualifications below.",
    addHab: "+ Add a qualification", addIntern: "+ Add a person", newHab: "New qualification",
    addOne: "Add", defRole: "member",
    ponderationTitle: "Day weighting",
    ponderationHint: "How much a shift \"weighs\" depending on the day, for the fairness calculation. A heavier Sunday or holiday will be shared out more evenly.",
    wWeek: "Weekday", wSat: "Saturday", wSun: "Sunday", wHol: "Holiday", resetDefaults: "Reset to defaults",
    postesHint: "Define the slots to cover each day and the required qualifications. With no required tag, the slot is open to everyone.",
    typeLabel: "Type", kGarde: "On-site", kAstreinte: "On-call",
    cadenceLabel: "Cadence", cadJour: "Daily", cadSemaine: "Weekly",
    cadBloc: "Multi-day", cadWe: "Weekend", cadSem5: "Week (Mon–Fri)", sem5Short: "Mo–Fr", spanLabel: "Number of days", dayShort: "d",
    periodNote: "Multi-day on-call — editing here reassigns the whole block.",
    genLive: "up to date", genComputing: "computing…", roleLabelSetting: "Term for people",
    loadOver: "load over",
    reqHab: "Required qualifications", addPoste: "+ Add a slot", newPoste: "New slot",
    newHabPlaceholder: "New qualification…", assignInTeam: "assign it in the Team tab",
    eligibleA: "eligible", eligibleP: "eligible", nobodyElig: "nobody is qualified — slot cannot be covered", onlyOneA: "only ", onlyOneB: " can cover this slot — load will concentrate on this person", fewEligA: "only ", fewEligB: " can cover this slot — load may concentrate",
    weekly: "weekly",
    footVersion: "Personal version · saved automatically on your device", resetData: "Reset all data",
    loading: "Loading…", warnPeriod: "Set a valid period first.",
    notQualifiedFor: "lacks the qualification required for",
    expDate: "Date", expDay: "Day", expDayType: "Day type", expSlot: "Slot", expKind: "Kind", expPerson: "Person",
    tHoliday: "Holiday", tSat: "Saturday", tSun: "Sunday", tWeek: "Weekday",
    pdfTitle: "ROTA — Schedule", pdfPeriod: "Period:",
    noExport: "Export is not allowed in this environment.", noPrint: "Printing is not allowed in this environment.",
    dHol: "holiday", dWE: "weekend",
    unavailA: "Tap the days when ", unavailB: " is unavailable. The schedule avoids them.",
    semIntroA: "Fairness accumulates over the ", semIntroB: " months of the exercise: each month's carry-over feeds the next to even out the load.",
    habManageHint: "Rename, add or remove a qualification. People and slots update automatically.",
    teamEditHint: "Edit the team: tap a name to change it, adjust the carry-over, tick qualifications. Everything recomputes live.",
    report: "Carry-over",
    bourseIntro: "Shift swaps: offer an on-call shift (from the Month tab, \"Swap\" button), then assign it here to a replacement.",
    bourseEmptyFull: "No shift offered yet. In the Month tab, tap a day then \"Swap\" on the relevant shift.",
    offerGivenBy: "given up by", equityFoot: "Planning cue: assign the shortest bars first.",
    loadingT: "Loading…", defIntern: "Person", defPoste: "New slot", defHab: "Qualification",
  },
};

// Filet de sécurité : en cas d'erreur d'exécution, on affiche un message propre
// (au lieu d'un écran blanc) avec des options de récupération.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // silencieux : l'utilisateur voit le message ci-dessous
  }
  clearData = () => {
    try { if (typeof window !== "undefined" && storage && storage.delete) storage.delete("rota:state"); } catch (e) {}
    try { if (typeof localStorage !== "undefined") localStorage.removeItem("rota:state"); } catch (e) {}
    setTimeout(() => window.location.reload(), 120);
  };
  render() {
    if (!this.state.error) return this.props.children;
    const wrap = { minHeight: "100vh", background: "#0e1116", color: "#f4ede4", fontFamily: "'Spline Sans Mono', monospace", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 };
    const card = { maxWidth: 380, textAlign: "center" };
    const btn = { display: "block", width: "100%", margin: "10px 0 0", padding: "12px 0", borderRadius: 10, border: "1px solid #2a323d", background: "#1c232d", color: "#f4ede4", fontFamily: "inherit", fontSize: 14, cursor: "pointer" };
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>◷</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>Une erreur est survenue</div>
          <div style={{ fontSize: 12.5, color: "#8a93a0", lineHeight: 1.5, marginBottom: 6 }}>
            L'application a rencontré un problème et s'est arrêtée. Tes données sont normalement conservées.
          </div>
          <button style={btn} onClick={() => window.location.reload()}>Recharger l'application</button>
          <button style={{ ...btn, borderColor: "#e0613c", color: "#e0613c" }} onClick={this.clearData}>
            Vider les données et recharger
          </button>
        </div>
      </div>
    );
  }
}

function AppInner() {
  const [interns, setInterns] = useState(SEED_INTERNS);
  const [tab, setTab] = useState("mois");
  const [moisView, setMoisView] = useState("mois");
  const [sel, setSel] = useState(null);
  const [mode, setMode] = useState("plan"); // plan | indispo
  const [activePerson, setActivePerson] = useState(SEED_INTERNS[0].id);
  const [unavail, setUnavail] = useState({}); // clé "moisIdx-internId-dIdx" → true
  const [posts, setPosts] = useState(SEED_POSTS);
  const [selMonth, setSelMonth] = useState(0); // index dans la période
  const [startISO, setStartISO] = useState("2026-05-01");
  const [endISO, setEndISO] = useState("2026-10-31");
  const [overrides, setOverrides] = useState({}); // "moisIdx-dIdx-posteId" → internId | "" (vide)
  const histRef = useRef({ past: [], future: [] }); // historique des modifications manuelles
  const [, bumpHist] = useState(0);
  const [offers, setOffers] = useState([]); // bourse : {id, monthIdx, dIdx, postId, from}
  const [votes, setVotes] = useState({}); // "moisIdx-internId" → "pour"|"contre"
  const [validated, setValidated] = useState({}); // moisIdx → true
  const [respo, setRespo] = useState({}); // moisIdx → internId (sinon rotation auto)
  const [tagList, setTagList] = useState(SEED_TAGS);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [theme, setTheme] = useState("dark");
  const [lang, setLang] = useState("fr");
  const [roleLabel, setRoleLabel] = useState("");
  const tx = (k) => (TR[lang] && TR[lang][k]) || TR.fr[k] || k;
  const MONTHS = MONTH_NAMES[lang] || MONTH_NAMES.fr;
  const DOWL = DOW_NAMES[lang] || DOW_NAMES.fr;
  const roleName = (roleLabel && roleLabel.trim()) || tx("defRole");
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
            histRef.current = { past: [], future: [] };
            if (d.offers) setOffers(d.offers);
            if (d.votes) setVotes(d.votes);
            if (d.validated) setValidated(d.validated);
            if (d.respo) setRespo(d.respo);
            if (d.tagList) setTagList(d.tagList);
            if (d.weights) setWeights({ ...DEFAULT_WEIGHTS, ...d.weights });
            if (d.theme) setTheme(d.theme);
            if (d.lang) setLang(d.lang);
            if (d.roleLabel !== undefined) setRoleLabel(d.roleLabel);
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
    const data = JSON.stringify({ interns, posts, unavail, startISO, endISO, activePerson, overrides, offers, votes, validated, respo, tagList, weights, theme, lang, roleLabel });
    const t = setTimeout(() => { storage.set("rota:state", data).catch(() => {}); }, 400);
    return () => clearTimeout(t);
  }, [loaded, interns, posts, unavail, startISO, endISO, activePerson, overrides, offers, votes, validated, respo, tagList, weights, theme, lang, roleLabel]);

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
    histRef.current = { past: [], future: [] };
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
  const computing = dInterns !== interns || dPosts !== posts || dUnavail !== unavail || dOverrides !== overrides || dWeights !== weights;
  const sem = useMemo(
    () => (valid ? simulateSemester(dInterns, dPosts, dUnavail, months, dOverrides, dWeights) : []),
    [dInterns, dPosts, dUnavail, months, valid, dOverrides, dWeights]
  );

  useEffect(() => {
    if (selMonth > months.length - 1) setSelMonth(Math.max(0, months.length - 1));
  }, [months.length, selMonth]);

  const safeMonth = Math.min(selMonth, Math.max(0, sem.length - 1));
  const cur = sem[safeMonth]; // mois affiché dans l'onglet Mois

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
      histRef.current.past.push(o);
      if (histRef.current.past.length > 50) histRef.current.past.shift();
      histRef.current.future = [];
      const n = { ...o };
      const k = mi + "-" + dIdx + "-" + postId;
      if (value === null) delete n[k];
      else n[k] = value;
      return n;
    });
    bumpHist((x) => x + 1);
  }
  function undoEdit() {
    const h = histRef.current;
    if (!h.past.length) return;
    setOverrides((o) => { h.future.push(o); return h.past.pop(); });
    bumpHist((x) => x + 1);
  }
  function redoEdit() {
    const h = histRef.current;
    if (!h.future.length) return;
    setOverrides((o) => { h.past.push(o); return h.future.pop(); });
    bumpHist((x) => x + 1);
  }
  const canUndo = histRef.current.past.length > 0;
  const canRedo = histRef.current.future.length > 0;

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
      alert(tx("noExport"));
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
    const now = new Date();
    const stamp = iso(now) + "T" + pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
    let s = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//ROTA//FR\r\nCALSCALE:GREGORIAN\r\n";
    evs.forEach((e) => {
      const nd = new Date(e.date); nd.setDate(nd.getDate() + 1);
      const kind = (e.p.kind || "garde") === "astreinte" ? tx("kAstreinte") : tx("kGarde");
      // UID stable (date + poste) : réimporter met à jour au lieu de dupliquer
      s += "BEGIN:VEVENT\r\nUID:rota-" + iso(e.date) + "-" + e.p.id + "@rota\r\n";
      s += "DTSTAMP:" + stamp + "\r\n";
      s += "DTSTART;VALUE=DATE:" + iso(e.date) + "\r\nDTEND;VALUE=DATE:" + iso(nd) + "\r\n";
      s += "SUMMARY:" + e.p.label + " \u00b7 " + e.it.name + " (" + kind + ")\r\nEND:VEVENT\r\n";
    });
    s += "END:VCALENDAR\r\n";
    download("astreintes.ics", s, "text/calendar");
  }
  function exportCSV() {
    const evs = collectEvents();
    const rows = [[tx("expDate"), tx("expDay"), tx("expDayType"), tx("expSlot"), tx("expKind"), tx("expPerson")].join(";")];
    evs.forEach((e) => {
      const d = e.date;
      const dd = pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
      const tj = e.day.holiday ? tx("tHoliday") : e.day.wd === 5 ? tx("tSat") : e.day.wd === 6 ? tx("tSun") : tx("tWeek");
      const kind = (e.p.kind || "garde") === "astreinte" ? tx("kAstreinte") : tx("kGarde");
      rows.push([dd, DOWL[e.day.wd], tj, e.p.label, kind, e.it.name].join(";"));
    });
    download("astreintes.csv", "\ufeff" + rows.join("\r\n"), "text/csv");
  }
  function exportPDF() {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    let body = "<h1>" + esc(tx("pdfTitle")) + "</h1>";
    body += '<div class="sub">' + esc(tx("pdfPeriod")) + " " + startISO.split("-").reverse().join("/") + " → " + endISO.split("-").reverse().join("/") + "</div>";
    sem.forEach((m) => {
      body += "<h2>" + esc(MONTHS[m.monthIdx]) + " " + m.year + "</h2>";
      body += "<table><thead><tr><th>" + esc(tx("expDay")) + "</th>" + posts.map((p) => "<th>" + esc(p.label) + "</th>").join("") + "</tr></thead><tbody>";
      m.days.forEach((day, dIdx) => {
        if (day.inRange === false) return;
        const cls = day.holiday ? "hol" : day.wd >= 5 ? "we" : "";
        const cells = posts.map((p) => {
          const a = m.assignments.find((x) => x.dIdx === dIdx && x.post === p.id);
          const it = a && a.intern != null ? byId(a.intern) : null;
          return "<td>" + (it ? esc(it.name) : "—") + "</td>";
        }).join("");
        body += '<tr class="' + cls + '"><td class="d">' + day.date + " " + DOWL[day.wd] + "</td>" + cells + "</tr>";
      });
      body += "</tbody></table>";
    });
    const html =
      '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8"><title>' + esc(tx("pdfTitle")) + '</title><style>' +
      "*{font-family:Arial,Helvetica,sans-serif;} h1{font-size:20px;margin:0 0 2px;} .sub{color:#555;font-size:12px;margin-bottom:14px;}" +
      "h2{font-size:15px;margin:18px 0 6px;} table{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:10px;}" +
      "th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;} th{background:#f0f0f0;} td.d{white-space:nowrap;color:#333;}" +
      "tr.we td{background:#f6f1e6;} tr.hol td{background:#f3e4d6;} @media print{h2{page-break-after:avoid;}}" +
      "</style></head><body>" + body + "</body></html>";
    try {
      const frame = document.createElement("iframe");
      frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
      document.body.appendChild(frame);
      const d = frame.contentWindow.document;
      d.open(); d.write(html); d.close();
      frame.onload = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) {}
        setTimeout(() => { try { document.body.removeChild(frame); } catch (e) {} }, 1500);
      };
    } catch (e) {
      alert(tx("noPrint"));
    }
  }

  // gestion des habilitations (tags) — propagation aux internes et postes
  function addTag() {
    setTagList((l) => {
      let base = tx("defHab"), n = l.length + 1, name = base + " " + n;
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
    setInterns((p) => [...p, { id, name: roleName + " " + id, tags: [], carry: 0, color }]);
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
    setPosts((p) => [...p, { id, label: tx("defPoste"), requires: [], color, kind: "garde", cadence: "jour", span: 3 }]);
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
  // Créer une habilitation depuis un poste : l'ajoute à la liste (donc visible dans
  // Équipe) et la marque requise sur ce poste.
  function addTagToPost(postId, rawName) {
    const name = (rawName || "").trim();
    if (!name) return;
    setTagList((l) => (l.includes(name) ? l : [...l, name]));
    setPosts((p) =>
      p.map((x) =>
        x.id === postId
          ? { ...x, requires: x.requires.includes(name) ? x.requires : [...x.requires, name] }
          : x
      )
    );
  }

  const lastSem = sem.length ? sem[sem.length - 1] : null;
  const perPerson = useMemo(() => {
    const acc = {};
    interns.forEach((i) => (acc[i.id] = { total: 0, we: 0, hol: 0, wk: 0 }));
    sem.forEach((m) => {
      m.assignments.forEach((a) => {
        if (a.intern == null || !acc[a.intern]) return;
        const day = m.days[a.dIdx];
        if (!day) return;
        acc[a.intern].total++;
        if (day.holiday) acc[a.intern].hol++;
        else if (day.wd >= 5) acc[a.intern].we++;
        else acc[a.intern].wk++;
      });
    });
    return acc;
  }, [sem, interns]);
  const finalScores = lastSem ? interns.map((i) => lastSem.score[i.id] || 0) : [0];
  const spread = (Math.max(...finalScores) - Math.min(...finalScores)).toFixed(1);
  const maxMonthCount = Math.max(
    ...sem.flatMap((m) => interns.map((i) => m.count[i.id] || 0)),
    1
  );

  function heatBg(n) {
    const r = n / maxMonthCount;
    if (r > 0.75) return "var(--hot)";
    if (r > 0.45) return "var(--mid)";
    if (r > 0) return "var(--cool)";
    return "var(--panel2)";
  }

  if (!loaded) {
    return (
      <div className={theme === "light" ? "rota-light" : ""} style={S.shell}>
        <style>{CSS}</style>
        <div style={S.splash}>
          <div style={S.logoMark}>◷</div>
          <div style={S.splashText}>{tx("loadingT")}</div>
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
            <div style={S.appSub}>{tx("appSub")}</div>
          </div>
        </div>
        <div style={S.headRight}>
          <button
            onClick={() => setLang((l) => (l === "fr" ? "en" : "fr"))}
            style={S.langBtn}
            aria-label={tx("langAria")}
          >
            🌐 {lang === "fr" ? "FR" : "EN"}
          </button>
          <button
            onClick={() => setTheme((th) => (th === "light" ? "dark" : "light"))}
            style={S.themeBtn}
            aria-label={tx("themeAria")}
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
          <select
            value={String(months.length)}
            onChange={(e) => setDuration(Number(e.target.value))}
            style={S.monthSelect}
            aria-label={tx("durationAria")}
          >
            {Array.from(new Set([1, 3, 6, 12, months.length])).sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>{n} {tx("months")}</option>
            ))}
          </select>
        </div>
      </header>

      {/* barre Exercice : période de planification */}
      <section style={S.exerciseBar}>
        <span style={S.exLabel}>{tx("exercise")}</span>
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
          ["mois", tx("tPlanning")],
          ["bourse", tx("tBourse") + (offers.length ? " (" + offers.length + ")" : "")],
          ["stats", tx("tStats")],
          ["equipe", tx("tEquipe")],
          ["postes", tx("tPostes")],
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

      <div style={S.genBar}>
        <span style={{ ...S.genPill, ...(computing ? S.genPillBusy : S.genPillOk) }}>
          {computing ? "⟳ " + tx("genComputing") : "✓ " + tx("genLive")}
        </span>
      </div>

      {/* ---------------- MOIS ---------------- */}
      {tab === "mois" && (
        <section style={S.body}>
          <div style={S.viewSwitch}>
            {[["mois", tx("tMois")], ["semestre", tx("tSemestre")]].map(([v, l]) => (
              <button key={v} onClick={() => setMoisView(v)}
                style={{ ...S.viewBtn, ...(moisView === v ? S.viewBtnOn : {}) }}>{l}</button>
            ))}
          </div>
          {moisView === "mois" && (
          !valid || !cur ? (
            <div style={S.warn}>
              {tx("warnPeriod")}
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
              <span style={S.monthTitleName}>{MONTHS[cur.monthIdx]} {cur.year}</span>
              <span style={S.monthTitleSub}>{cur.len} {tx("days")} · {tx("months")} {safeMonth + 1}/{months.length}</span>
            </div>
            <button
              onClick={() => { setSelMonth((m) => Math.min(months.length - 1, m + 1)); setSel(null); }}
              disabled={safeMonth >= months.length - 1}
              style={{ ...S.navArrow, ...(safeMonth >= months.length - 1 ? S.navArrowOff : {}) }}
            >
              ›
            </button>
          </div>

          {/* annuler / rétablir les modifications manuelles */}
          <div style={S.histBar}>
            <button onClick={undoEdit} disabled={!canUndo}
              style={{ ...S.histBtn, ...(canUndo ? {} : S.histOff) }}>{tx("undo")}</button>
            <button onClick={redoEdit} disabled={!canRedo}
              style={{ ...S.histBtn, ...(canRedo ? {} : S.histOff) }}>{tx("redo")}</button>
          </div>

          {/* responsable du mois + statut de validation */}
          <div style={{ ...S.respoBar, borderColor: validated[safeMonth] ? "var(--cool)" : "var(--line)" }}>
            <div style={S.respoLeft}>
              <span style={S.respoLabel}>{tx("responsable")}</span>
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
              {validated[safeMonth] ? tx("validated") : tx("brouillon")}
            </span>
          </div>

          {/* sélecteur de mode */}
          <div style={S.modeRow}>
            {[
              ["plan", tx("planifier")],
              ["indispo", tx("indispos")],
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
              posts.map((po) => (
                <span key={po.id} style={S.legendItem}>
                  <span style={{ ...S.legendRing, borderColor: po.color }} />
                  {po.label}
                </span>
              ))
            ) : (
              <span style={S.legendNote}>
                {tx("unavailA")}<b style={{ color: byId(activePerson)?.color }}>{byId(activePerson)?.name}</b>{tx("unavailB")}
              </span>
            )}
          </div>

          <div style={S.weekHead}>
            {DOWL.map((d, i) => (
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
              const uncovered = a.some((x) => x.intern == null);
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
                    ...(mode === "plan" && uncovered ? S.cellAlert : {}),
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
                        const po = postById(x.post);
                        const ring = po ? po.color : "var(--line)";
                        return (
                          <span
                            key={k}
                            title={po ? po.label + (who ? " · " + who.name : "") : ""}
                            style={{
                              ...S.dot,
                              background: who ? who.color : "transparent",
                              color: who ? textOn(who.color) : "transparent",
                              border: who ? "2.5px solid " + ring : "2px dashed " + ring,
                            }}
                          >
                            {who ? who.name.charAt(0).toUpperCase() : ""}
                          </span>
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
                <div style={S.detailHint}>{tx("tapDay")}</div>
              ) : (
                <>
                  <div style={S.detailHead}>
                    {MONTHS[cur.monthIdx]} {cur.days[sel].date} · {DOWL[cur.days[sel].wd]}
                    {cur.days[sel].holiday ? " · " + tx("dHol") : ""}
                    {(cur.days[sel].wd === 5 || cur.days[sel].wd === 6) ? " · " + tx("dWE") : ""}
                  </div>
                  {(assignByDay[sel] || [])
                    .map((x, k) => {
                      const it = byId(x.intern);
                      const p = postById(x.post);
                      if (!p) return null;
                      const isPer = p.cadence === "semaine" || p.cadence === "we" || p.cadence === "sem5" || (p.cadence === "bloc" && (p.span || 1) >= 2);
                      const editMi = isPer ? x.anchorMi : safeMonth;
                      const editIdx = isPer ? x.anchorDIdx : sel;
                      const okey = editMi + "-" + editIdx + "-" + x.post;
                      const ov = overrides[okey];
                      const selVal = ov === undefined ? "auto" : (ov === "" ? "" : String(ov));
                      const isOffered = offers.some((o) => o.monthIdx === editMi && o.dIdx === editIdx && o.postId === x.post);
                      const badHab = it && !p.requires.every((t) => it.tags.includes(t));
                      const cadenceTag = p.cadence === "semaine" ? " · " + tx("weekly")
                        : p.cadence === "we" ? " · " + tx("cadWe")
                        : p.cadence === "sem5" ? " · " + tx("sem5Short")
                        : (isPer ? " · " + (p.span || 1) + tx("dayShort") : "");
                      return (
                        <div key={k} style={S.editRow}>
                          <div style={S.editTop}>
                            <span style={S.detailPost}>
                              {p.label}
                              <span style={S.kindTag}>{(p.kind || "garde") === "astreinte" ? tx("kAstreinte") : tx("kGarde")}{cadenceTag}</span>
                            </span>
                            <span style={S.editTag}>
                              {x.intern && it && (<span style={{ ...S.detailDot, background: it.color }} />)}
                              {it ? it.name : <span style={S.detailEmpty}>{tx("uncovered")}</span>}
                              {x.forced && <span style={S.forcedTag}>{tx("manual")}</span>}
                            </span>
                          </div>
                          {isPer && <div style={S.weekNote}>{tx("periodNote")}</div>}
                          <div style={S.editCtrls}>
                            <select
                              value={selVal}
                              onChange={(e) => {
                                const v = e.target.value;
                                setOverride(editMi, editIdx, x.post, v === "auto" ? null : (v === "" ? "" : Number(v)));
                              }}
                              style={S.editSelect}
                            >
                              <option value="auto">{tx("auto")}</option>
                              <option value="">{tx("leaveEmpty")}</option>
                              {interns.map((i) => {
                                const ok = p.requires.every((t) => i.tags.includes(t));
                                return <option key={i.id} value={i.id}>{i.name}{ok ? "" : tx("notQualified")}</option>;
                              })}
                            </select>
                            {x.intern && (
                              isOffered
                                ? <span style={S.offeredTag}>{tx("listed")}</span>
                                : <button style={S.offerBtn} onClick={() => offerShift(editMi, editIdx, x.post)}>{tx("swap")}</button>
                            )}
                          </div>
                          {badHab && <div style={S.habWarn}>⚠ {it.name} {tx("notQualifiedFor")} {p.label}</div>}
                        </div>
                      );
                    })}
                </>
              )}
            </div>
          )}

          {/* validation collégiale du mois */}
          <div style={S.votePanel}>
            <div style={S.voteHead}>{tx("validationTitle")}</div>
            <div style={S.voteHint}>
              {tx("each")} {byId(respoOf(safeMonth))?.name || tx("responsable")} {tx("validates")}
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
                {voteTally(safeMonth).pour} {tx("pour")} · {voteTally(safeMonth).contre} {tx("contre")}
              </span>
              <button
                onClick={() => toggleValidated(safeMonth)}
                style={{ ...S.validateBtn, ...(validated[safeMonth] ? S.validateBtnOn : {}) }}
              >
                {validated[safeMonth] ? tx("annulerValidation") : tx("validerMois")}
              </button>
            </div>
          </div>
          </>
          )
          )}
        </section>
      )}

      {/* ---------------- BOURSE ---------------- */}
      {tab === "bourse" && (
        <section style={S.body}>
          <div style={S.semIntro}>
            {tx("bourseIntro")}
          </div>
          {offers.length === 0 ? (
            <div style={S.emptyBourse}>
              {tx("bourseEmptyFull")}
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
                      <div style={S.offerWhen}>{MONTHS[m.monthIdx]} {day.date} · {p.label}</div>
                      <div style={S.offerFrom}>
                        {tx("offerGivenBy")}
                        <span style={{ ...S.detailDot, background: fromI?.color, margin: "0 4px" }} />
                        {fromI?.name}
                      </div>
                    </div>
                    <button style={S.offerCancel} onClick={() => cancelOffer(o.id)}>✕</button>
                  </div>
                  <div style={S.offerTake}>
                    <span style={S.offerTakeLabel}>{tx("assignTo")}</span>
                    <div style={S.offerChips}>
                      {elig.length === 0 ? (
                        <span style={S.detailEmpty}>{tx("noReplacement")}</span>
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
      {tab === "mois" && moisView === "semestre" && (
        <section style={S.body}>
          {!valid ? (
            <div style={S.warn}>
              {tx("warnPeriod")}
            </div>
          ) : (
          <>
          <div style={S.semIntro}>
            {tx("semIntroA")}{months.length}{tx("semIntroB")}
          </div>

          {/* mini-calendriers */}
          <div style={S.miniScroll}>
            {sem.map((m, mi) => (
              <div key={mi} style={S.miniMonth}>
                <div style={S.miniName}>{MONTHS[m.monthIdx]}</div>
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
                <div key={i} style={S.mHead}>{MONTHS[m.monthIdx].slice(0, 3)}</div>
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
              {tx("spreadLabel")}
              <br />
              <span style={S.spreadSub}>{tx("spreadSub")}</span>
            </span>
          </div>

          {/* export du planning */}
          <div style={S.exportCard}>
            <div style={S.habTitle}>{tx("exportTitle")}</div>
            <div style={S.habHint}>
              {tx("exportHint")}
            </div>
            <select value={exportWho} onChange={(e) => setExportWho(e.target.value)} style={S.exportSelect}>
              <option value="all">{tx("everyone")}</option>
              {interns.map((i) => (<option key={i.id} value={i.id}>{i.name} {tx("only")}</option>))}
            </select>
            <div style={S.exportBtns}>
              <button onClick={exportICS} style={S.exportBtn}>{tx("btnIcs")}</button>
              <button onClick={exportCSV} style={S.exportBtn}>{tx("btnCsv")}</button>
            </div>
            <button onClick={exportPDF} style={S.pdfBtn}>{tx("btnPdf")}</button>
          </div>
          </>
          )}
        </section>
      )}

      {/* ---------------- STATS ---------------- */}
      {tab === "stats" && (
        <section style={S.body}>
          {!valid ? (
            <div style={S.warn}>{tx("warnPeriod")}</div>
          ) : (
            <>
              <div style={S.teamHint}>
                {tx("statsHintA")}{months.length} {tx("months")}{tx("statsHintB")}
              </div>
              <div style={S.statHead}>
                <span style={{ ...S.statCell, ...S.statName }}>{tx("colPerson")}</span>
                <span style={S.statCell}>{tx("colTotal")}</span>
                <span style={S.statCell}>{tx("colWk")}</span>
                <span style={S.statCell}>{tx("colWE")}</span>
                <span style={S.statCell}>{tx("colHol")}</span>
                <span style={S.statCell}>{tx("colLoad")}</span>
              </div>
              {interns
                .slice()
                .sort((a, b) => (lastSem ? (lastSem.score[b.id] || 0) - (lastSem.score[a.id] || 0) : 0))
                .map((i) => {
                  const s = perPerson[i.id] || { total: 0, we: 0, hol: 0, wk: 0 };
                  const charge = lastSem ? lastSem.score[i.id] || 0 : 0;
                  return (
                    <div key={i.id} style={S.statRow}>
                      <span style={{ ...S.statCell, ...S.statName }}>
                        <span style={{ ...S.statDot, background: i.color }} />
                        {i.name}
                      </span>
                      <span style={{ ...S.statCell, ...S.statStrong }}>{s.total}</span>
                      <span style={S.statCell}>{s.wk}</span>
                      <span style={S.statCell}>{s.we}</span>
                      <span style={S.statCell}>{s.hol}</span>
                      <span style={{ ...S.statCell, color: "var(--accent)" }}>{charge.toFixed(0)}</span>
                    </div>
                  );
                })}
              <div style={S.statNote}>
                {tx("statNote")}
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
            <div style={S.habTitle}>{tx("habTitle")}</div>
            <div style={S.habHint}>
              {tx("habManageHint")}
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
            <button onClick={addTag} style={S.addBtn}>{tx("addHab")}</button>
          </div>

          <div style={S.roleRow}>
            <span style={S.wLabel}>{tx("roleLabelSetting")}</span>
            <input
              value={roleLabel}
              placeholder={tx("defRole")}
              onChange={(e) => setRoleLabel(e.target.value)}
              style={S.roleInput}
            />
          </div>

          <div style={S.teamHint}>
            {tx("teamEditHint")}
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
                <span style={S.carryLabel}>{tx("report")}</span>
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
          <button onClick={addIntern} style={S.addBtn}>{"+ " + tx("addOne") + " " + roleName}</button>
        </section>
      )}

      {/* ---------------- POSTES ---------------- */}
      {tab === "postes" && (
        <section style={S.body}>
          {/* pondération de pénibilité par type de jour */}
          <div style={S.habCard}>
            <div style={S.habTitle}>{tx("ponderationTitle")}</div>
            <div style={S.habHint}>
              {tx("ponderationHint")}
            </div>
            <div style={S.wGrid}>
              {[["week", tx("wWeek")], ["sat", tx("wSat")], ["sun", tx("wSun")], ["holiday", tx("wHol")]].map(([k, l]) => (
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
            <button onClick={() => setWeights(DEFAULT_WEIGHTS)} style={S.wReset}>{tx("resetDefaults")}</button>
          </div>

          <div style={S.teamHint}>
            {tx("postesHint")}
          </div>
          {posts.map((p) => {
            const eligible = interns.filter((i) => p.requires.every((t) => i.tags.includes(t)));
            const eligibleCount = eligible.length;
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

                <div style={S.segLabel}>{tx("typeLabel")}</div>
                <div style={S.seg}>
                  {[["garde", tx("kGarde")], ["astreinte", tx("kAstreinte")]].map(([v, l]) => (
                    <button key={v} onClick={() => setPostField(p.id, "kind", v)}
                      style={{ ...S.segBtn, ...((p.kind || "garde") === v ? S.segOn : {}) }}>{l}</button>
                  ))}
                </div>
                <div style={S.segLabel}>{tx("cadenceLabel")}</div>
                <select
                  value={p.cadence || "jour"}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPosts((ps) => ps.map((x) => x.id === p.id ? { ...x, cadence: v, ...(v === "bloc" && !x.span ? { span: 3 } : {}) } : x));
                  }}
                  style={S.cadenceSelect}
                >
                  <option value="jour">{tx("cadJour")}</option>
                  <option value="bloc">{tx("cadBloc")}</option>
                  <option value="sem5">{tx("cadSem5")}</option>
                  <option value="we">{tx("cadWe")}</option>
                  <option value="semaine">{tx("cadSemaine")}</option>
                </select>
                {p.cadence === "bloc" && (
                  <div style={S.spanRow}>
                    <span style={S.wLabel}>{tx("spanLabel")}</span>
                    <input
                      type="number" min="2" max="31" step="1"
                      value={p.span || 3}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setPostField(p.id, "span", isNaN(n) ? 2 : Math.max(2, n));
                      }}
                      style={S.wInput}
                    />
                  </div>
                )}

                <div style={S.reqLabel}>{tx("reqHab")}</div>
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
                <NewHabInput placeholder={tx("newHabPlaceholder")} onAdd={(name) => addTagToPost(p.id, name)} />
                <div
                  style={{
                    ...S.eligNote,
                    color: eligibleCount === 0 ? "var(--hot)" : eligibleCount <= 2 ? "var(--mid)" : "var(--muted)",
                  }}
                >
                  {eligibleCount === 0
                    ? "⚠ " + tx("nobodyElig") + " — " + tx("assignInTeam")
                    : eligibleCount === 1
                    ? "⚠ " + tx("onlyOneA") + eligible[0].name + tx("onlyOneB")
                    : eligibleCount === 2
                    ? "⚠ " + tx("fewEligA") + eligible.map((e) => e.name).join(", ") + tx("fewEligB")
                    : eligibleCount + " " + (eligibleCount > 1 ? tx("eligibleP") : tx("eligibleA"))}
                </div>
              </div>
            );
          })}
          <button onClick={addPost} style={S.addBtn}>{tx("addPoste")}</button>
        </section>
      )}

      {/* Équité cumulée — aide à la planification, placée en bas */}
      {cur && (
      <section style={S.equityCard}>
        <div style={S.equityTitle}>
          {tx("cumLoad")} <span style={S.equityHint}>{startISO.split("-").reverse().join("/")} → {endISO.split("-").reverse().join("/")} · {tx("wholePeriod")}</span>
        </div>
        {(() => {
          const load = (lastSem && lastSem.score) || cur.score;
          const maxLoad = Math.max(...Object.values(load).map((v) => v || 0), 1);
          return interns
            .slice()
            .sort((a, b) => (load[b.id] || 0) - (load[a.id] || 0))
            .map((i) => {
              const sc = load[i.id] || 0;
              const pct = (sc / maxLoad) * 100;
              return (
                <div key={i.id} style={S.barRow}>
                  <div style={S.barName}>{i.name}</div>
                  <div style={S.barTrack}>
                    <div style={{ ...S.barFill, width: pct + "%", background: i.color }} />
                  </div>
                  <div style={S.barScore}>{sc.toFixed(1)}</div>
                </div>
              );
            });
        })()}
        <div style={S.equityFoot}>
          {tx("equityFoot")}
        </div>
      </section>
      )}

      <footer style={S.footer}>
        <button onClick={resetAll} style={S.resetBtn}>{tx("resetData")}</button>
        <div style={S.footNote}>{tx("footVersion")}</div>
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
  legendRing: { width: 11, height: 11, borderRadius: "50%", border: "2.5px solid", background: "transparent", boxSizing: "border-box" },

  weekHead: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4, marginBottom: 5 },
  weekHeadCell: { textAlign: "center", fontSize: 10, color: "var(--muted)", letterSpacing: 0.3 },
  grid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 },
  blank: { aspectRatio: "1 / 1.15" },
  cell: { aspectRatio: "1 / 1.15", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 9, padding: "4px 0 0", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", cursor: "pointer", fontFamily: mono },
  cellSpecial: { background: "var(--panel2)", borderColor: "rgba(240,201,135,.35)" },
  cellAlert: { background: "rgba(224,97,60,.12)", borderColor: "var(--hot)" },
  cellSel: { borderColor: "var(--accent)", boxShadow: "0 0 0 1px var(--accent)" },
  cellOut: { background: "transparent", border: "1px dashed var(--line)", opacity: 0.4, cursor: "default" },
  cellNumOut: { fontSize: 11, color: "var(--muted)" },
  cellNum: { fontSize: 12, color: "var(--ink)", fontWeight: 500 },
  dots: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 3, paddingBottom: 6 },
  dot: { width: 16, height: 16, borderRadius: "50%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8.5, fontWeight: 700, lineHeight: 1, fontFamily: mono },

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
  pdfBtn: { width: "100%", marginTop: 8, padding: "11px 0", borderRadius: 10, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--ink)", fontFamily: mono, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  histBar: { display: "flex", gap: 8, marginBottom: 12 },
  histBtn: { flex: 1, padding: "8px 0", borderRadius: 9, border: "1px solid var(--line)", background: "var(--panel2)", color: "var(--ink)", fontFamily: mono, fontSize: 12, cursor: "pointer" },
  histOff: { opacity: 0.35, cursor: "default" },
  statHead: { display: "flex", alignItems: "center", padding: "6px 8px", fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4, borderBottom: "1px solid var(--line)" },
  statRow: { display: "flex", alignItems: "center", padding: "9px 8px", borderBottom: "1px solid var(--line)", fontFamily: mono, fontSize: 12.5 },
  statCell: { flex: 1, textAlign: "center", color: "var(--ink)" },
  statName: { flex: 2.2, textAlign: "left", display: "flex", alignItems: "center", gap: 8 },
  statStrong: { fontWeight: 700 },
  statDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0 },
  statNote: { fontSize: 11, color: "var(--muted)", marginTop: 12, lineHeight: 1.5 },
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
  spanRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px" },
  roleRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", marginBottom: 12 },
  roleInput: { flex: 1, maxWidth: 180, background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink)", fontFamily: mono, fontSize: 13, padding: "8px 10px", textAlign: "right" },
  genBar: { display: "flex", justifyContent: "center", padding: "0 16px 6px" },
  genPill: { fontSize: 10.5, fontFamily: mono, borderRadius: 20, padding: "3px 10px", border: "1px solid var(--line)" },
  genPillOk: { color: "var(--cool)", borderColor: "var(--cool)" },
  genPillBusy: { color: "var(--mid)", borderColor: "var(--mid)" },
  viewSwitch: { display: "flex", gap: 6, background: "var(--panel2)", padding: 4, borderRadius: 12, marginBottom: 14 },
  viewBtn: { flex: 1, padding: "9px 0", background: "transparent", border: "none", borderRadius: 8, color: "var(--muted)", fontFamily: mono, fontSize: 13, cursor: "pointer" },
  viewBtnOn: { background: "var(--panel)", color: "var(--ink)", fontWeight: 600 },
  cadenceSelect: { width: "100%", background: "var(--panel2)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 9, fontFamily: mono, fontSize: 13, padding: "9px 10px" },
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

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
