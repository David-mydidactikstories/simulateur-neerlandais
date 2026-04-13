# SIMULATEUR VOCAL NÉERLANDAIS — MDS
## Architecture & État du projet (mis à jour avril 2026)

---

## 🎯 BUT DU PROJET

Simulateur vocal pédagogique pour apprendre le néerlandais professionnel. David joue le rôle d'un conseiller Cofidis qui doit poser ses questions **EN NÉERLANDAIS** pour remplir un dossier de crédit. 10 clients IA progressifs, checklist dynamique des champs, corrections linguistiques en temps réel, débrief final en français.

---

## 🚀 DÉPLOIEMENT

**URL en ligne :** *(à configurer sur Render)*

**Repo GitHub :** *(à créer)*

**Pour mettre à jour en ligne après une modification :**
```
git add -A && git commit -m "description du changement" && git push
```
Render redéploie automatiquement en 2-3 minutes après chaque push.

**Variables d'environnement (ne jamais mettre dans le code) :**
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- `NL_PORT` (optionnel, défaut : 3001)

> ⚠️ Le `.env` local pointe vers `../Simulateur Vocal/.env` (même fichier de clés partagé).
> En prod Render, configurer les 3 variables directement dans le dashboard.

---

## 🏗️ ARCHITECTURE TECHNIQUE

**Frontend :** `public/index.html` — Interface, 10 profils clients, checklist dynamique, corrections
**Audio Worklet :** `public/audio-processor.js` — Capture micro (AudioWorkletNode, linear16 PCM)
**Backend :** `server.js` — Node.js + Express + WebSocket (`ws`)
**Guide PDF :** `public/guide_pratique.pdf` — Aide-mémoire questions NL, accessible via bouton "Guide"

**IA Trio :**
- **STT** : Deepgram Nova-2 streaming (`wss://`) — `nova-2`, `language=nl`, `utterance_end_ms=2500`, `numerals=true`, `keepalive=true`, `smart_format` désactivé
- **LLM** : Gemini `gemini-2.5-flash-lite` REST API — JSON mode, historique glissant (20 messages), retry 503/429 (2 tentatives, 2,5 s)
- **TTS** : ElevenLabs REST — `eleven_turbo_v2_5`, `mp3_22050_32`, `voiceSettings` par profil

---

## 📁 FICHIERS CLÉS

```
Simulateur Neerlandais/
├── server.js                  ← Backend principal (Deepgram NL, Gemini, ElevenLabs, WS)
├── package.json               ← start: "node server.js", port 3001
├── .gitignore                 ← exclut .env et node_modules
└── public/
    ├── index.html             ← Interface + 10 profils clients + checklist dynamique
    ├── audio-processor.js     ← AudioWorklet PCM (identique au Simulateur Vocal)
    └── guide_pratique.pdf     ← Guide PDF des questions NL (généré par make_guide.py)
```

> `make_guide.py` (à la racine du projet) : script Python/ReportLab pour regénérer le PDF guide.

---

## ✅ FONCTIONNALITÉS COMPLÈTES

- [x] 10 profils clients progressifs (niveaux 1 à 10) avec `voiceId` et `voiceSettings` individuels
- [x] Champs fixes par profil (`champsIds`) — liste plate, 7 à 9 champs par profil
- [x] Checklist dynamique construite côté client après message `fields_selected` du serveur
- [x] Scoring +2/-2 par réplique, barre de progression dossier
- [x] Correction linguistique en temps réel (bulle ambre, disparaît après 8 sec)
- [x] Deepgram NL streaming avec keepalive (toutes les 8 s) — évite les déconnexions pendant la lecture audio
- [x] `corrigerTranscription()` — fixes pré-Gemini : Cofidis, mag ik, rijksregisternummer, @
- [x] Débrief automatique en FRANÇAIS après dossier complet
- [x] `pendingGameOver` — le débrief attend la fin de la file audio
- [x] Son de victoire : arpège Do-Mi-Sol-Do (Web Audio API oscillateurs)
- [x] AudioWorklet (`audio-processor.js`) — remplace ScriptProcessorNode déprécié
- [x] Fix audio iOS Safari : lecture via `AudioContext.decodeAudioData`
- [x] WebSocket `wss://` en HTTPS (Render), `ws://` en local — auto-détecté
- [x] Anti-doublon `dernierEnvoi` — évite de traiter deux fois la même phrase
- [x] Historique des 4 derniers échanges (chat log David gris / Client bleu)
- [x] **Guide PDF** accessible via bouton "Guide" dans le header et la colonne droite

---

## 🧠 LOGIQUE SERVEUR (server.js) — FONCTIONS CLÉS

| Fonction | Rôle |
|---|---|
| `corrigerTranscription(texte)` | Corrige les erreurs STT courantes avant envoi à Gemini |
| `construireChamps(champsIds)` | Construit la liste de champs depuis les IDs du profil (liste plate) |
| `appelGemini(body)` | Appel Gemini avec retry 503/429 (2 essais, 2,5 s backoff) |
| `setupDeepgram()` | Ouvre la connexion Deepgram NL streaming + keepAlive toutes les 8 s |
| `evaluerQuestion(questionDavid)` | Appelle Gemini, évalue la question NL, met à jour la checklist |
| `declencherDebrief()` | Génère le feedback linguistique en français après dossier complet |
| `genererVoix(texte)` | Appelle ElevenLabs avec voiceSettings du profil, renvoie MP3 base64 |

**Variables d'état par session WebSocket :**
- `historique[]` — conversation glissante (20 derniers messages)
- `champsRequis[]` — champs de la session (liste plate, construite par `construireChamps`)
- `champsRemplis[]` — champs déjà collectés
- `currentConfig` — profil client actif (envoyé par le frontend via message `config`)
- `isGameOver` / `isIAThinking` — états de jeu
- `transcriptBuffer` — accumulation des transcriptions finales entre deux `UtteranceEnd`
- `dernierEnvoi` — anti-doublon sur la dernière phrase traitée

---

## 📋 CHAMPS DISPONIBLES (ALL_CHAMPS dans server.js)

| id | label NL | Traduction FR |
|---|---|---|
| `naam` | Naam + voornaam | Nom + Prénom |
| `adres` | Adres | Adresse complète |
| `geboortedatum` | Geboortedatum | Date de naissance |
| `rijksregisternummer` | Rijksregisternummer | N° de registre national |
| `identiteitskaart` | Kopie identiteitskaart (r/v) | Copie carte d'identité |
| `kredietbedrag` | Kredietbedrag | Montant du crédit demandé |
| `kredietdoel` | Doel van het krediet | But du crédit |
| `burgerlijke_staat` | Burgerlijke staat | État civil |
| `kinderen_ten_laste` | Kinderen ten laste + bijslag | Enfants à charge + allocations |
| `beroep_type` | Beroepssituatie | Situation professionnelle (type) |
| `maandinkomen` | Maandelijks inkomen | Revenu mensuel net |
| `bewijs_inkomen` | Bewijsdocument inkomen | Justificatif de revenu à envoyer |

> `bewijs_inkomen` et `identiteitskaart` ne peuvent être marqués `champ_rempli` que si le message de David contient `@` (adresse e-mail confirmée).

---

## 👥 10 PROFILS CLIENTS

| Niveau | Nom | Profil | Comportement | Voice ID EL |
|---|---|---|---|---|
| 1 | Meneer Janssen | Gepensioneerd · Gent | Lent, clair, coopératif | wqDY19Brqhu7UCoLadPh |
| 2 | Mevrouw De Smedt | Verpleegkundige · Leuven | Vitesse normale, sympa | gC9jy9VUxaXAswovchvQ |
| 3 | Meneer Maes | Bediende · Brussel | Léger accent bruxellois | ruSJRhA64v8HAqiqKXVw |
| 4 | Mevrouw Claes | Zelfstandige · Hasselt | Assez vite, accent limbourgeois | HAAKLJlaJeGl18MKHYeg |
| 5 | Meneer Pieters | Arbeider · Antwerpen | Accent anversois, direct, bref | WLKp2jV6nrS8aMkPPDRO |
| 6 | Mevrouw Wouters | Werkloze · Gent | Vite, expressions gantaises | MiueK1FXuZTCItgbQwPu |
| 7 | Meneer Hermans | Arbeidsongeschikt · Liège | Accent liégeois, hésitations | o3Pmyfc3Ez1s2CJKuwJf |
| 8 | Mevrouw Stevens | Bediende · Kortrijk | Fort accent ouest-flamand, vite | pjcYQlDFKMbcOUp6F5GD |
| 9 | Meneer Dubois | Gepensioneerd · Tongeren | Fort accent limbourgeois | PrYUlaJFEdOSVy6jaEaG |
| 10 | Mevrouw Vandenberghe | Zelfstandige · Brugge | Très rapide, west-flamand fort | qMfbtjrTDTlGtBy52G6E |

---

## 🎯 RULES SYSTÈME GEMINI (résumé)

- **Règle fondamentale** : le client est TOUJOURS coopératif, répond sans exception — jamais de refus
- **Règle 0** : client = CLIENT, David = conseiller. Identification une seule fois, pas de répétition
- **Règle email** : `bewijs_inkomen` et `identiteitskaart` → `champ_rempli` uniquement si `@` présent
- **Rijksregisternummer** : inventé fictif format XX.XX.XX-XXX.XX, épelé chiffre par chiffre en NL
- **Dates** : toujours en toutes lettres néerlandaises (jamais de chiffres dans `reponse`)
- **Document vague** : le client demande QUEL document avant de sauter à l'e-mail
- **Correction** : toujours en français, null si NL correct ; ne juge pas la prononciation de "Cofidis"
- **Débrief** : `LANGUE DE RÉPONSE : FRANÇAIS UNIQUEMENT`

---

## 🔧 CORRECTIONS STT (corrigerTranscription)

| Erreur Deepgram | Correction appliquée |
|---|---|
| `koffie disies`, `kofidis`... | → `Cofidis` |
| `appelstaartje` / ` at ` | → `@` |
| `maak je uw` | → `mag ik uw` |
| `kan je uw` | → `kunt u uw` |
| `kunnen u` | → `kunt u` |
| `hebben u` | → `heeft u` |
| `direct register nummer`, `rijks registernummer`... | → `rijksregisternummer` |
| `en dat is je X` | → `en wat is uw X` |

---

## 🏆 SCORING PÉDAGOGIQUE

| Situation | Variation |
|---|---|
| Question correcte en NL + info obtenue | +1 à +2 |
| Erreur de NL mais intention claire | 0 (correction fournie) |
| Grosse erreur NL ou question en français | -1 (correction fournie) |

---

## 📖 GUIDE PRATIQUE PDF

Fichier : `public/guide_pratique.pdf` (régénérable via `python make_guide.py`)

**Contenu :**
- **Section 1 — Phrases passe-partout** : ouverture, transitions, reformulation, clôture
- **Section 2 — Questions par champ** : 4-7 formulations par information à collecter (NL + traduction)
- **Section 3 — Vocabulaire clé** : 30 mots essentiels pour comprendre les réponses

Accessible via le bouton **"Guide"** dans le header et la colonne droite du simulateur.

---

## ⚠️ PIÈGES CONNUS

1. **`.env` local** pointe vers `../Simulateur Vocal/.env` — en prod Render, configurer les variables directement dans le dashboard
2. **Port 3001** en local (pour ne pas conflicther avec le port 3000 du Simulateur Vocal)
3. **Free tier Render** — le service s'endort après 15 min d'inactivité (cold start ~30 sec)
4. **Gemini safety block** — géré par le catch (réponse de secours "Sorry, kunt u dat herhalen?")
5. **Deepgram déconnexion** pendant la lecture audio — résolu par `KeepAlive` JSON toutes les 8 s
6. **`smart_format=true`** désactivé — causait des fusions phonétiques (ex: "ja hallo" → "jaro")
7. **`gemini-2.0-flash-lite`** n'est plus disponible (HTTP 404) — utiliser `gemini-2.5-flash-lite`

---

## 📈 LIEN AVEC LE PROJET MDS

Ce simulateur fait partie du catalogue MDS (My Didactik Stories).
Voir le modèle économique dans `../Simulateur Vocal/Modèle Économique MDS.docx`.

- **Pilote** : 490€ (accès 30 jours, 1 utilisateur)
- **PME** : Setup + licence annuelle 1.500-2.000€ + recharges 1,50€/crédit
