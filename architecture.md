# SIMULATEUR VOCAL NÉERLANDAIS — MDS
## Architecture & État du projet (mis à jour avril 2026)

---

## 🎯 BUT DU PROJET

Simulateur vocal pédagogique pour apprendre le néerlandais professionnel. L'utilisateur joue le rôle d'un conseiller Cofidis qui doit poser ses questions **EN NÉERLANDAIS** pour remplir un dossier de crédit. 10 niveaux progressifs avec 2 variantes aléatoires chacun, checklist dynamique, corrections linguistiques en temps réel, débrief pédagogique complet en français.

---

## 🚀 DÉPLOIEMENT

**URL en ligne :** `https://simulateur-neerlandais.onrender.com`

**Repo GitHub :** `https://github.com/David-mydidactikstories/simulateur-neerlandais`

**Pour mettre à jour en ligne après une modification :**
```bash
git add -A
git commit -m "description du changement"
git push origin main
```
Render redéploie automatiquement en 2-3 minutes après chaque push.

**Variables d'environnement (ne jamais mettre dans le code) :**
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- `NL_PORT` (optionnel, défaut : 3001)

> ⚠️ En local : le `.env` pointe vers `../Simulateur Vocal/.env` (fichier partagé).
> En prod Render : les 3 variables sont configurées directement dans le dashboard.

> ⚠️ Free tier Render : le service s'endort après ~15 min d'inactivité (cold start ~50 sec).

---

## 🏗️ ARCHITECTURE TECHNIQUE

**Frontend :** `public/index.html` — Interface, 20 variantes de profils, mode écoute, débrief
**Audio Worklet :** `public/audio-processor.js` — Capture micro (AudioWorkletNode, linear16 PCM)
**Backend :** `server.js` — Node.js + Express + WebSocket (`ws`)
**Guide PDF :** `public/guide_pratique.pdf` — Aide-mémoire questions NL

**IA Trio :**
| Service | Rôle | Config |
|---|---|---|
| **Deepgram** Nova-2 | STT streaming NL | `language=nl`, `utterance_end_ms=3500`, `numerals=true`, keepalive 8s, `smart_format` désactivé |
| **Gemini** 2.5-flash-lite | LLM réponses client | JSON mode, historique glissant 20 msg, retry 503/429 (2×, 2,5s) |
| **ElevenLabs** | TTS voix client | `eleven_turbo_v2_5`, `mp3_22050_32`, voiceSettings par profil |

---

## 📁 FICHIERS CLÉS

```
Simulateur Neerlandais/
├── server.js                  ← Backend principal
├── package.json               ← start: "node server.js", port 3001
├── architecture.md            ← Ce fichier
├── .gitignore                 ← exclut .env et node_modules
└── public/
    ├── index.html             ← Interface + 20 profils + mode écoute + débrief
    ├── audio-processor.js     ← AudioWorklet PCM 16kHz
    └── guide_pratique.pdf     ← Guide PDF des questions NL
```

---

## ✅ FONCTIONNALITÉS

### Démarrage
- [x] **Modal accueil** : saisie du prénom + sélection Monsieur/Madame avant la simulation
- [x] `userName` et `userGender` transmis au serveur, utilisés dans le prompt Gemini et le débrief

### Profils clients
- [x] **20 variantes** — 2 personas par niveau, tirée au sort à chaque sélection de niveau (`pickProfile()`)
- [x] `LEVEL_CONFIGS` : voix et comportement fixés par niveau, persona (nom, champs, humeur) aléatoire
- [x] `comportementInstructie` : difficulté progressive (bienveillant niv.1 → glacial niv.10)
- [x] `humeurInstructie` : personnalité distinctive (jovial, sarcastique, fatigué, pressé...)
- [x] `situationProInstructie` : instructions spécifiques par type de situation pro (`SIT` object)
- [x] `champsIds` différents par variante pour éviter la répétition

### Appel téléphonique
- [x] **Décroché initial** : le client parle en premier ("Ja, hallo? Met [nom]...") après 800ms
- [x] Scoring +2/-2 par réplique, barre de progression dossier
- [x] Correction linguistique en temps réel (bulle ambre, disparaît après 8s)
- [x] **Phase goodBye** : dossier complet → conseiller doit prendre congé → débrief
- [x] `corrigerTranscription()` — fixes pré-Gemini (Cofidis, mag ik, rijksregisternummer, @...)

### Mode écoute
- [x] **Bouton Masquer/Afficher** — floute le texte du client (CSS `blur(7px)`)
- [x] Clic sur texte flouté → révèle 3 secondes puis se refloute automatiquement
- [x] Historique des échanges supprimé (entraînement à la compréhension orale)

### Deepgram
- [x] Streaming NL avec keepalive JSON toutes les 8s (évite déconnexion pendant TTS)
- [x] `utterance_end_ms=3500` (plus généreux pour les utilisateurs hésitants)
- [x] `smart_format` désactivé (causait fusions phonétiques)
- [x] Anti-doublon `dernierEnvoi`

### Débrief pédagogique
- [x] Déclenché après la prise de congé (goodbyePhase) + fin de la file audio
- [x] Structure JSON complète : encouragement, points forts, grammaire, conjugaison, vocabulaire, prononciation, phrase modèle
- [x] Modal scrollable, sections colorées par thème
- [x] Titre personnalisé "Bravo [prénom] !"

### Audio
- [x] `pendingGameOver` — débrief attend fin de file audio
- [x] Son de victoire : arpège Do-Mi-Sol-Do (Web Audio API)
- [x] AudioWorklet (remplace ScriptProcessorNode déprécié)
- [x] Fix iOS Safari : lecture via `AudioContext.decodeAudioData`
- [x] `wss://` en HTTPS (Render), `ws://` en local — auto-détecté

---

## 🧠 LOGIQUE SERVEUR (server.js)

### Fonctions clés

| Fonction | Rôle |
|---|---|
| `corrigerTranscription(texte)` | Corrige les erreurs STT avant envoi à Gemini |
| `construireChamps(champsIds)` | Construit la liste de champs depuis les IDs du profil |
| `appelGemini(body)` | Appel Gemini avec retry 503/429 |
| `setupDeepgram()` | Ouvre connexion Deepgram NL streaming + keepAlive |
| `genererDecroché()` | Génère la phrase d'ouverture du client selon le niveau |
| `evaluerQuestion(question)` | Appelle Gemini, évalue la question NL, met à jour checklist |
| `declencherDebrief()` | Génère le feedback pédagogique complet en français |
| `genererVoix(texte)` | Appelle ElevenLabs, renvoie MP3 base64 |

### Variables d'état par session WebSocket

| Variable | Rôle |
|---|---|
| `historique[]` | Conversation glissante (20 derniers messages) |
| `champsRequis[]` | Champs de la session (construits par `construireChamps`) |
| `champsRemplis[]` | Champs déjà collectés |
| `currentConfig` | Profil client actif (envoyé par le frontend via message `config`) |
| `goodbyePhase` | `true` quand dossier complet, attend prise de congé |
| `isGameOver` / `isIAThinking` | États de jeu |
| `transcriptBuffer` | Accumulation des transcriptions finales entre deux `UtteranceEnd` |
| `dernierEnvoi` | Anti-doublon sur la dernière phrase traitée |

### Données du profil transmises au serveur (via message `config`)

```javascript
{
  type: 'config',
  nom, role, voiceId, voiceSettings,
  champsIds,          // liste des champs à collecter
  prompt,             // description du personnage
  situationProInstructie,   // instructions revenu/docs selon type pro
  comportementInstructie,   // difficulté comportementale (niv 1-10)
  humeurInstructie,         // personnalité (humour, sarcasme, fatigue...)
  userName,           // prénom saisi par l'utilisateur
  userGender,         // 'M' ou 'F' — pour meneer/mevrouw
  sampleRate,
}
```

---

## 📋 CHAMPS DISPONIBLES (ALL_CHAMPS dans server.js)

| id | Label NL | Traduction FR |
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
| `bewijs_inkomen` | Bewijsdocument inkomen | Justificatif de revenu |

---

## 👥 20 VARIANTES DE PROFILS (LEVEL_CONFIGS)

| Niveau | Variante A | Variante B | Voix EL |
|---|---|---|---|
| 1 | Meneer Janssen (gepensioneerd, Gent) | Mevrouw Peeters (gepensioneerde, Leuven) | wqDY19Brqhu7UCoLadPh |
| 2 | Mevrouw De Smedt (verpleegkundige, Leuven) | Meneer Goossens (bediende, Antwerpen) | gC9jy9VUxaXAswovchvQ |
| 3 | Meneer Maes (bediende, Brussel) | Mevrouw Nijs (HR manager, Brussel) | ruSJRhA64v8HAqiqKXVw |
| 4 | Mevrouw Claes (zelfstandige, Hasselt) | Meneer Leclercq (bediende, Tongeren) | HAAKLJlaJeGl18MKHYeg |
| 5 | Meneer Pieters (arbeider, Antwerpen) | Mevrouw Bogaert (bediende, Mechelen) | WLKp2jV6nrS8aMkPPDRO |
| 6 | Mevrouw Wouters (werkloze, Gent) | Meneer Van Acker (werkloze, Gent) | MiueK1FXuZTCItgbQwPu |
| 7 | Meneer Hermans (arbeidsongeschikt, Liège) | Mevrouw Simon (arbeidsongeschikte, Verviers) | o3Pmyfc3Ez1s2CJKuwJf |
| 8 | Mevrouw Stevens (bediende, Kortrijk) | Meneer Desmet (zelfstandige, Roeselare) | pjcYQlDFKMbcOUp6F5GD |
| 9 | Meneer Dubois (gepensioneerd, Tongeren) | Mevrouw Truyen (gepensioneerde, Hasselt) | PrYUlaJFEdOSVy6jaEaG |
| 10 | Mevrouw Vandenberghe (zelfstandige, Brugge) | Meneer Vermeersch (zelfstandige, Gent) | qMfbtjrTDTlGtBy52G6E |

---

## 🎯 RÈGLES SYSTÈME GEMINI (résumé)

| Règle | Description |
|---|---|
| **Fondamentale** | Client TOUJOURS coopératif, répond sans exception |
| **Anti-rôle** | Le client ne pose JAMAIS de questions sur le dossier/crédit |
| **No-volunteering** | Le client ne donne AUCUNE info sans être interrogé |
| **Répétition** | Si "kunt u herhalen" → client répète, légèrement reformulé |
| **Vérification** | Après geboortedatum / adres / rijksregisternummer / maandinkomen → demande confirmation |
| **Règle 0** | Conseiller = meneer/mevrouw [prénom utilisateur]. Client ne devine jamais le nom du conseiller |
| **Email** | `bewijs_inkomen` / `identiteitskaart` → `champ_rempli` uniquement si `@` dans l'historique |
| **Rijksregisternummer** | Format réel belge `JJ.MM.DD-XXX.CC` avec checksum mod 97 valide, cohérent avec geboortedatum. Sur `/realtime` : généré par `genererRRN()`. Lecture en 2 étapes : d'abord en groupes naturels (jaartal, maand, dag, puis 3 chiffres, puis 2), puis chiffre-par-chiffre en fallback si le conseiller ne comprend pas. |
| **Montants/Dates** | Toujours en toutes lettres NL — jamais de chiffres dans `reponse` |
| **Kinderen** | Nécessite DEUX infos : nombre d'enfants + montant kinderbijslag |
| **Correction** | Toujours en français, null si NL correct |
| **GoodBye** | Dossier complet → signal `goodbye_phase` → conseiller prend congé → débrief |

---

## 🔧 CORRECTIONS STT (corrigerTranscription)

| Erreur Deepgram | Correction |
|---|---|
| `koffie disies`, `kofidis`, `cofides`... | → `Cofidis` |
| `appelstaartje` / ` at ` | → `@` |
| `maak je uw` / `maak je ook` | → `mag ik uw` / `mag ik ook` |
| `kan je uw` | → `kunt u uw` |
| `kunnen u` / `hebben u` | → `kunt u` / `heeft u` |
| `direct register nummer`, `rijks registernummer`... | → `rijksregisternummer` |
| `en dat is je X` | → `en wat is uw X` |
| `mag ik naar mijn/uw/je X` | → `mag ik uw X` (Deepgram entend mal `uw` en fast speech) |

---

## 📊 STRUCTURE DU DÉBRIEF PÉDAGOGIQUE (JSON Gemini)

```json
{
  "encouragement":  "message chaleureux 2 phrases",
  "points_forts":   ["exemple concret 1", "exemple concret 2"],
  "grammaire":      [{ "erreur": "...", "correction": "...", "explication": "..." }],
  "conjugaison":    [{ "erreur": "...", "correction": "...", "explication": "..." }],
  "vocabulaire":    [{ "mot_nl": "...", "traduction": "...", "exemple": "..." }],
  "prononciation":  "feedback accent/prononciation basé sur transcription Deepgram",
  "phrase_modele":  "question exemplaire en NL pour ce contexte crédit"
}
```

> ⚠️ Sur la branche **`/realtime`** (Gemini Live), le champ `prononciation` est un **objet structuré** car le débrief reçoit l'audio user en inline et écoute réellement :
> ```json
> "prononciation": {
>   "global":  "1-2 phrases sur accent/débit/intonation/assurance (basé sur l'écoute audio)",
>   "erreurs": [
>     { "mot": "rijksregisternummer", "probleme": "ij prononcé 'i' au lieu de 'ay'", "conseil": "..." },
>     { "mot": "goedendag", "probleme": "g dur (R français) au lieu de g doux flamand", "conseil": "..." },
>     { "mot": "...", "probleme": "...", "conseil": "..." }
>   ]
> }
> ```
> Le frontend `realtime.html` accepte les deux formats (string legacy + objet) pour rester rétro-compatible.

---

## 🏆 SCORING PÉDAGOGIQUE

| Situation | Variation |
|---|---|
| Question correcte en NL + info obtenue | +1 à +2 |
| Erreur de NL mais intention claire | 0 (correction fournie) |
| Grosse erreur NL ou question en français | -1 (correction fournie) |

---

## ⚠️ PIÈGES CONNUS

1. **`.env` local** pointe vers `../Simulateur Vocal/.env` — en prod Render, configurer les variables directement dans le dashboard
2. **Port 3001** en local (évite le conflit avec le Simulateur Vocal port 3000)
3. **Free tier Render** — service endormi après ~15 min d'inactivité, cold start ~50 sec
4. **Gemini safety block** — géré par le catch (réponse de secours "Sorry, kunt u dat herhalen?")
5. **Deepgram déconnexion** pendant TTS — résolu par `KeepAlive` JSON toutes les 8s
6. **`smart_format=true`** désactivé — causait fusions phonétiques ("ja hallo" → "jaro")
7. **`gemini-2.0-flash-lite`** n'est plus disponible (HTTP 404) — utiliser `gemini-2.5-flash-lite`
8. **Git locks** — si commit échoue avec "HEAD.lock / index.lock", faire `rm -f .git/*.lock` dans le terminal VS Code

---

## 🧪 BRANCHE PARALLÈLE — PROTOTYPE GEMINI LIVE (Vlaams)

**Statut :** Proto fonctionnel en local, à valider sur la voix Vlaams.
**Objectif :** migrer le simulateur vers une archi **speech-to-speech directe** via Gemini Live (cible <1s de latence vs 2-3s avec la cascade Deepgram+ElevenLabs), avec voix **néerlandaise belge (Vlaams)**.

### Accès parallèle
- **Page classique** (Deepgram + Gemini texte + ElevenLabs) : `/`  → inchangée
- **Page proto Live** : `/realtime`  → nouvelle, en parallèle stricte
- **WS classique** : `/`  → `ws` principal sans modification fonctionnelle
- **WS proto** : `/ws-realtime`  → routé en `noServer` par le handler `upgrade`

### Fichiers ajoutés
```
Simulateur Neerlandais/
├── server-realtime.js          ← module pont WS frontend ↔ Gemini Live
└── public/
    └── realtime.html           ← UI parallèle (modal accueil + 2 variantes niv 1 + checklist + débrief)
```

### Modifs minimes dans `server.js`
1. `require('./server-realtime')` + `path` ajoutés en tête.
2. Le `wss` principal passé en `noServer: true` ; routage `upgrade` par path.
3. Route `app.get('/realtime', …)` qui sert `public/realtime.html`.
4. Appel `realtimeBranch.attachWebSocket(server, geminiKey)` après création du serveur.
5. **Bug syntaxe corrigé** : un backtick orphelin dans le template literal du `promptDebrief` (ancienne version cassait le démarrage Node ; sans rapport avec le proto Live mais bloquant).

### Archi du flux (HYBRIDE Live + Deepgram)
```
Navigateur ─── binary PCM 16kHz Int16 LE ───→  server-realtime.js
                                                      │
                                              ┌───────┴────────┐
                                              │                │
                                              ▼                ▼
                                       Gemini Live WS    Deepgram nl WS
                                       (voix client)     (transcription propre)
                                              │                │
                  audio_chunk PCM 24kHz ←─────┘                │
                  input_audio_transcription                    │
                  (bruité → affichage live uniquement)         │
                                                               │
                  transcription is_final → dgUserTrBuffer ◄────┘
                  (source de vérité pour scorer & débrief)

Frontend ←── audio_chunk + interim_text ←── server-realtime.js

À chaque turnComplete du Live :
   userTr = corrigerTranscription(dgUserTrBuffer)   ← Deepgram, propre
   aiTr   = currentAiTr (output_audio_transcription Live)
   historique.push({user: userTr, ai: aiTr})
   ↓
   Scorer REST (Gemini 2.5 Flash Lite) → champ_rempli + correction + ending_signal
   ↓ (si dossier complet ou ending_signal='accept')
   goodbye_phase → tour suivant → Débrief REST (Gemini 2.5 Flash Lite)
   ↓
   game_over avec JSON débrief structuré
```

**Pourquoi l'hybride :** la `input_audio_transcription` du modèle Live native-audio (preview-12-2025) hallucine régulièrement des mots en allemand/suédois/anglais sur des phrases NL parlées (ex: "Jag tycker det koning Albert Stratet ingen" pour "Het is de Koning Albertlaan"). Ces transcriptions pollutent scorer et débrief. Deepgram nova-2 `language=nl` donne une transcription propre.

**Audio dupliqué :** chaque chunk PCM 16kHz reçu du frontend est envoyé en parallèle vers Live (génère la voix) et vers Deepgram (génère la transcription). Pas de latence supplémentaire perceptible côté audio puisque les deux flux sont indépendants.

**Fallback :** si `DEEPGRAM_API_KEY` est absente, le serveur continue à fonctionner en utilisant la transcription Live native (mode dégradé). Un warning console est loggé au démarrage.

### Setup Gemini Live (format snake_case)
- `model` : `models/gemini-2.5-flash-native-audio-preview-12-2025`  (override : `GEMINI_LIVE_MODEL`)
- `generation_config.response_modalities` : `['AUDIO']`
- `speech_config.voice_config.prebuilt_voice_config.voice_name` : `Charon`  (override : `GEMINI_LIVE_VOICE`)
- `speech_config.language_code` : ❌ **retiré** — le modèle `gemini-2.5-flash-native-audio-preview-12-2025` ferme le WS avec `close code 1007 "Unsupported language code 'nl-BE'"` si on l'envoie. Les modèles native-audio auto-détectent la langue à partir de l'audio + `system_instruction`. À retenter si Google relâche la contrainte côté API.
- `system_instruction.parts[].text` : Vlaams + rôle client coopératif + champs + comportement niv 1
- `input_audio_transcription: {}`  ← active la transcription de l'utilisateur côté serveur
- `output_audio_transcription: {}`  ← active la transcription de l'IA côté serveur

### Pièges identifiés pour le proto
1. **Octet orphelin PCM** : les chunks audio Live reçus peuvent avoir une longueur en bytes impaire si la trame est tronquée. Le frontend garde `pcmLeftoverByte` pour le coller au chunk suivant — sans ça, friture audible.
2. **AudioContext séparés** : capture à 16 kHz (worklet PCM existant, réutilisé), lecture à 24 kHz (nouveau contexte avec `nextPlayTime` pour scheduling continu). Ne pas mélanger les deux.
3. **Buffer audio avant setupComplete** : le frontend commence à streamer dès que le micro est ouvert, mais Gemini Live n'accepte les chunks qu'après `setupComplete`. Le serveur tamponne jusqu'à 50 chunks le temps que le setup arrive, puis flush.
4. **`isPlaying` côté frontend** : tant que le client IA parle, on ne renvoie pas le micro pour éviter la rétro-audition (echoCancellation aide mais ne suffit pas toujours). Conséquence : l'utilisateur ne peut pas interrompre dans ce proto. À retirer plus tard si on veut les interruptions natives Live.
5. **Fermeture WS sur "Arrêter"** : NE PAS fermer le WS immédiatement. Frontend envoie `{type:'stop'}`, attend `game_over`, ferme seulement quand le modal débrief s'affiche.
6. **Détection de fin** : le scorer renvoie `ending_signal: 'accept' | 'refuse' | 'continue'` pour signaler conversationnellement la prise de congé. Sans ce side-channel, Gemini Live ne sait pas que le jeu se termine et peut clore arbitrairement.

### Point d'attention CRITIQUE — voix Vlaams
Le néerlandais belge n'est **PAS** un voice_name distinct chez Gemini Live. Les modèles native-audio auto-détectent la langue à partir de l'audio + des instructions système. Stratégie :

| Voix testée | Note empirique | Verdict |
|---|---|---|
| `Charon`  | _à tester en premier — timbre grave, neutre_ | _à remplir_ |
| `Kore`    | _à tester — voix féminine_ | _à remplir_ |
| `Aoede`   | _à tester_ | _à remplir_ |
| `Orus`    | _à tester_ | _à remplir_ |
| `Leda`    | _à tester_ | _à remplir_ |
| `Puck`    | _à éviter — connu pour accent hollandais marqué_ | _à remplir_ |

Pour pousser le modèle vers le Vlaams, le `system_instruction` est explicite :
> _"Je spreekt UITSLUITEND Vlaams (Belgisch Nederlands), NOOIT Hollands Nederlands. Gebruik typisch Vlaamse uitdrukkingen ('allee', 'zeker en vast', 'goesting', 'amai', 'wablieft?'). VERMIJD STRIKT Hollandse uitdrukkingen ('hartstikke', 'gezellig', 'lekker', 'joh', 'doei')."_

### Plan B si le Vlaams ne sonne jamais correct
Documenté ici en cas de bailout :
- Revenir à **ElevenLabs uniquement pour le TTS** sur ce projet (voix flamandes contrôlables, déjà 20 voix configurées par niveau).
- Garder **Gemini Live pour la STT + génération texte** : plus rapide que la cascade Deepgram+Gemini-texte, mais on perd l'avantage speech-to-speech direct.
- Ou rester sur l'archi classique pour ce simulateur (où ElevenLabs marche bien) et garder le proto Live pour les simulateurs en français/anglais.

### Variables d'environnement
```bash
GEMINI_API_KEY=...            # déjà présente
GEMINI_LIVE_MODEL=...         # défaut: gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_LIVE_VOICE=...         # défaut: Charon
GEMINI_DEBRIEF_MODEL=...      # défaut: gemini-2.5-flash (multimodal audio inline)
```

### Scope du proto (validé)
- ✅ Niveau 1 uniquement — 2 personas FIXES (Meneer Janssen voix grave, Mevrouw Peeters voix douce)
- ✅ **Scénario regénéré à chaque session** (cf. "Cerveau" ci-dessous)
- ✅ Branche parallèle stricte (route `/realtime`, l'existant reste intact sur `/`)
- ✅ Checklist dynamique (champsRequis / champsRemplis) maintenue
- ✅ Débrief pédagogique final (JSON identique à l'existant, prononciation multimodale)
- ❌ Corrections linguistiques en temps réel (à brancher plus tard via le scorer si voulu)
- ❌ Mode écoute (blur du texte client)
- ❌ Les 20 variantes (réutilisera `LEVEL_CONFIGS` quand le proto sera validé)

### "Cerveau" — scénario aléatoire à chaque appel ✅ (livré mai 2026)
**But** : avec seulement 2 personas, rendre chaque session **différente** pour la rejouabilité — le conseiller ne mémorise pas les réponses d'un coup sur l'autre.

**Ce qui reste FIXE** (le "persona") :
- `voornaam` + `familienaam` (Jan Janssen / Maria Peeters)
- `gender` (M / F)
- `voiceId` Gemini Live (timbre grave vs doux)
- `styleParole` + `humeur` (grand-père chaleureux vs grand-mère douce et un peu sourde)

**Ce qui est GÉNÉRÉ à chaque session** par `genererScenario(persona)` côté `server-realtime.js` :

| Champ | Pool / règle |
|---|---|
| `age` | `ageBase ± 5` (Janssen : 62-72, Peeters : 67-77) |
| `geboortedatum` | jour/mois random, année = `currentYear - age` |
| `rijksregisternummer` | **format belge réel** `YY.MM.DD-XXX.CC` avec **checksum mod 97 valide** (cohérent avec la geboortedatum) — testé 500 tirages = 100% valides |
| `ville` | tirage parmi 7 villes flamandes (Gent, Leuven, Antwerpen, Brugge, Mechelen, Hasselt, Kortrijk) |
| `adres` | rue (pool de 5-8 vraies rues par ville) + n° (1-250) + CP + ville |
| `situationFam` | tirage selon genre (M : gehuwd/weduwnaar/gescheiden ; F : gehuwd/weduwe/gescheiden) |
| `beroep` | **pondéré** : gepensioneerd 60%, arbeidsongeschikt 20%, werkloze 10%, bediende 10% |
| `inkomen` | range selon beroep (gepensioneerd 1100-1800, bediende 2200-3400, etc.), arrondi à 10€ |
| `bewijsDoc` | doc cohérent avec beroep (pensioenfiche vs loonfiche vs attest mutualiteit vs attest RVA) |
| `krediet.label_nl` + `kredietBedrag` | 7 buts possibles (auto, renovatie keuken/badkamer, reis, meubels, verbouwing, medisch), montants arrondis à 500€ |
| `champsIds` | 5 toujours requis (`naam, adres, beroep_type, maandinkomen, bewijs_inkomen`) + 2-3 random parmi 6 optionnels (`geboortedatum, rijksregisternummer, identiteitskaart, kredietbedrag, kredietdoel, burgerlijke_staat`) = **7 ou 8 champs par session** |

**Comment c'est utilisé** :
1. Au `config`, `genererScenario(persona)` est appelé → `currentProfil` est construit avec base persona + scénario généré.
2. `buildSystemInstruction(persona, scenario, ...)` injecte **toutes les vérités** (adres précis, RRN, montants, beroep, kredietdoel...) dans un bloc "⭐⭐ JOUW DOSSIER — DE FEITEN" du system_instruction. Le client Live a donc une "vérité" cohérente à toutes les questions, même hors `champsRequis`.
3. Les règles 5b/6/7/8 du system_instruction sont **paramétrées** par le scénario : "Voor rijksregisternummer : GEBRUIK het nummer uit jouw dossier (XX.XX.XX-XXX.XX), NOOIT een ander."
4. La carte persona côté UI affiche `nom · role · ville · age · situation · beroep` (scène générée) pour planter le décor sans spoiler le détail du dossier (RRN, montants, adresse précise, kredietdoel restent à extraire par le conseiller).

**Pourquoi déterministe (Node) plutôt que LLM** : zéro latence ajoutée, 100% prédictible, RRN garanti valide (mod 97), pas de risque d'adresse hollandaise / mois en français / format incohérent. Pools facilement éditables pour étendre aux niveaux 2-10.

**Exclusion volontaire au niv 1** : `kinderen_ten_laste` — les retraités n'ont quasi jamais d'enfants à charge, le double-info `aantal + bijslag` devient bancal. À réintégrer aux niveaux 2+ avec des persona plus jeunes.

**Logs serveur** : à chaque session, le serveur affiche `📋 [realtime] Persona A (Meneer Janssen) — scénario : 65a, gepensioneerd, Brugge, "renovatiekrediet voor mijn keuken" 15000€, 7 champs [naam, adres, ...]` pour debug.

### TODO test
1. Lancer en local : `npm start`, ouvrir `http://localhost:3001/realtime`
2. Tester voix `Charon` (défaut), puis `Kore`, `Aoede`, `Orus`, `Leda` en variant `GEMINI_LIVE_VOICE`
3. Évaluer la "belgité" perçue : vocabulaire (`allee`, `goesting`, `wablieft`), intonation (g douce, pas de roulement R), absence de "joh" / "hartstikke"
4. Mesurer latence ressentie (cible < 1s du silence à la réponse audio)
5. Compléter le tableau des voix testées ci-dessus + retenir la meilleure dans `GEMINI_LIVE_VOICE` par défaut
6. Si rien ne tient → activer Plan B

### Analyse audio multimodale du débrief ✅ (livré mai 2026)
**But** : remplacer la section "Accent & Prononciation" générique (basée sur la transcription) par un commentaire fondé sur l'**écoute réelle** de la voix de l'apprenant.

**Granularité retenue** (décidée au moment de l'impl) : **commentaire global + top 3 erreurs concrètes** identifiées dans l'audio (mot précis + problème entendu + conseil correctif).

**Pipeline côté `server-realtime.js`** :
1. Chaque chunk PCM 16kHz reçu du frontend est dupliqué dans `userAudioChunks[]` (en plus du forward vers Live et Deepgram), avec un cap `MAX_AUDIO_BYTES = 19.2 MB` (~10 min de session — au-delà, on tronque le DÉBUT plutôt qu'OOM).
2. Au moment du débrief, `buildWavBuffer()` encapsule les chunks en WAV PCM s16le mono 16kHz (header RIFF 44 bytes + data raw). Vérifié `file` + `ffprobe` : reconnu comme `Microsoft PCM, 16 bit, mono 16000 Hz`.
3. Le buffer est encodé base64 et envoyé en `inlineData.{mimeType: 'audio/wav', data: <b64>}` à **`gemini-2.5-flash`** (multimodal) en plus du transcript.
4. Le prompt débrief instruit explicitement le modèle : "écoute UNIQUEMENT la voix du conseiller (la voix du client IA n'est PAS dans l'audio fourni), cible les difficultés classiques du francophone en NL (g, ij, eu, ui, oe, sch, r, accents toniques, intonation, débit), ignore les mots propres français, identifie EXACTEMENT 3 erreurs précises et concrètes, n'invente JAMAIS une erreur que tu n'entends pas."
5. Si l'utilisateur n'a quasi rien dit (< 1 s d'audio cumulé), fallback texte-only sur `gemini-2.5-flash-lite` avec l'ancien format `prononciation: string`.

**Côté frontend `realtime.html`** : le renderer du débrief gère les **deux formats** (string legacy + objet `{global, erreurs[]}`) — pas de breaking change pour l'archi cascade `/` qui continue de renvoyer une string.

**Trade-offs assumés** :
- Modèle ~10× plus cher que `flash-lite`, mais appliqué une seule fois par session (le scorer par tour reste sur `flash-lite` texte).
- Latence débrief 5-10 s au lieu de 1-2 s — timeout porté à 45 s côté `appelGeminiREST`.
- Plafond ~10 min par session ; au-delà, troncature DÉBUT (cible : un proto niv 1 = 3-5 min, marge largement suffisante). Pour des sessions plus longues, basculer sur l'API Files (`https://generativelanguage.googleapis.com/upload/v1beta/files`) — non implémenté car non nécessaire ici.
- L'audio user accumulé est libéré (`userAudioChunks = []`) **dès** que le WAV est construit dans `triggerDebrief` pour éviter de garder ~20 MB par session en RAM jusqu'à la déconnexion WS.

**Variables d'env ajoutées** : `GEMINI_DEBRIEF_MODEL` (défaut `gemini-2.5-flash`) — override si on veut tester `gemini-2.5-pro` ou un modèle plus rapide.

---

## 📈 LIEN AVEC LE PROJET MDS

Ce simulateur fait partie du catalogue MDS (My Didactik Stories).
Voir le modèle économique dans `../Simulateur Vocal/Modèle Économique MDS.docx`.

- **Pilote** : 490€ (accès 30 jours, 1 utilisateur)
- **PME** : Setup + licence annuelle 1.500-2.000€ + recharges 1,50€/crédit
