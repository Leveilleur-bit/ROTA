# ROTA — planning de gardes & astreintes équitable

Maquette testable d'un outil de répartition équitable des gardes et astreintes
(internes en hôpital, mais adaptable). Mono-utilisateur, mobile-first, données
enregistrées **localement dans le navigateur** (`localStorage`).

## Lancer en local

Prérequis : [Node.js](https://nodejs.org) 18 ou plus.

```bash
npm install
npm run dev
```

Puis ouvrir l'URL affichée (par défaut `http://localhost:5173`).
Sur mobile, ouvrir cette URL depuis un téléphone sur le même réseau, ou utiliser
les outils de simulation mobile du navigateur (la maquette est pensée pour ~430px de large).

### Construire une version statique

```bash
npm run build      # génère le dossier dist/
npm run preview    # sert le build localement
```

Le contenu de `dist/` est déployable tel quel (Netlify, Vercel, GitHub Pages, etc.).

## Fonctionnalités

- **Génération automatique** d'un planning équitable : répartition pondérée par
  l'attractivité du jour (semaine / samedi / dimanche / férié), report de charge
  cumulé d'un mois sur l'autre, respect du repos de sécurité (gardes), habilitations
  requises par poste.
- **Vue mois** (calendrier, navigation entre mois nommés, fériés français calculés),
  **vue semestre** (synthèse d'équité, écart de charge).
- **Édition manuelle** d'une affectation, **bourse aux gardes**, **vote / responsable
  du mois**.
- **Postes configurables** : type *garde* ou *astreinte*, cadence *journalière* ou
  *hebdomadaire*, habilitations requises.
- **Habilitations**, **pondérations** et **période d'exercice** modifiables.
- **Mode clair / sombre**.
- **Export** du planning en `.ics` (agenda) et `.csv` (tableur), filtrable par personne.

## Données & confidentialité

Tout est stocké dans le `localStorage` du navigateur : les données ne quittent pas
l'appareil et ne sont pas partagées. Vider les données du site (ou le bouton
« Réinitialiser les données » en bas de l'app) efface tout.

> Ceci est une maquette pour tester l'ergonomie et l'algorithme, pas un produit de
> production. La version multi-utilisateur (comptes, serveur, conformité RGPD) fait
> l'objet d'un document d'architecture séparé.

## Structure

```
rota/
├─ index.html
├─ package.json
├─ vite.config.js
└─ src/
   ├─ main.jsx        # point d'entrée React
   ├─ App.jsx         # toute l'application
   └─ storage.js      # persistance via localStorage
```

## Licence

À définir.
