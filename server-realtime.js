// =====================================================================
// server-realtime.js — BRANCHE PARALLÈLE PROTOTYPE GEMINI LIVE
// =====================================================================
// Pont WebSocket entre le navigateur (/realtime) et l'API Gemini Live
// (speech-to-speech direct, modèle native-audio).
//
// Branché sur le même serveur HTTP qu'index.html (server.js) via le path
// WebSocket dédié /ws-realtime — ne modifie en RIEN l'archi cascade
// Deepgram + Gemini texte + ElevenLabs qui reste accessible sur "/".
//
// Spécificité projet : voix néerlandaise BELGE (Vlaams) — voir notes
// architecture.md section "BRANCHE PARALLÈLE — PROTOTYPE GEMINI LIVE".
// =====================================================================

const WebSocket = require('ws');

// ---------------------------------------------------------------------
// CONFIG — overridable via variables d'environnement
// ---------------------------------------------------------------------
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL
    || 'gemini-2.5-flash-native-audio-preview-12-2025';
// Voix par genre — chaque persona du proto a son genre fixe :
//   Janssen = M → Charon (timbre grave)
//   Peeters = F → Kore (timbre féminin sénior)
// `GEMINI_LIVE_VOICE` (legacy) override les DEUX si défini (rétro-compat).
//  Voix prebuilt à tester : Charon, Orus, Puck, Fenrir (M) ; Kore, Aoede, Leda, Zephyr (F)
//  Pour ce projet on cherche le timbre le moins "hollandais" — point sensible.
const LIVE_VOICE_M = process.env.GEMINI_LIVE_VOICE_M || process.env.GEMINI_LIVE_VOICE || 'Charon';
const LIVE_VOICE_F = process.env.GEMINI_LIVE_VOICE_F || process.env.GEMINI_LIVE_VOICE || 'Kore';
const pickLiveVoice = (gender) => gender === 'F' ? LIVE_VOICE_F : LIVE_VOICE_M;
const SCORER_MODEL  = 'gemini-2.5-flash-lite';
// Modèle multimodal pour le débrief enrichi audio (input audio inline + texte).
// Plus cher (~10×) et plus lent (5-10s) que flash-lite, mais nécessaire pour
// analyser l'accent/prononciation à partir de l'audio brut user.
const DEBRIEF_MODEL = process.env.GEMINI_DEBRIEF_MODEL || 'gemini-2.5-flash';

// Limite l'audio cumulé envoyé à Gemini pour le débrief.
// 16000 Hz * 2 bytes * 300 s = 9,600,000 bytes ≈ 9.6 MB pour 5 min de session.
// Le total payload (audio b64 + prompt) doit rester sous ~20 MB côté API ; on
// reste large pour éviter les rejets silencieux. Pour de plus longues sessions,
// basculer sur l'API Files (non implémenté).
const MAX_AUDIO_BYTES = 16000 * 2 * 300; // 5 min mono 16-bit 16kHz

// Deepgram (hybride) — fournit la transcription "officielle" de l'input utilisateur.
// La transcription native Gemini Live (input_audio_transcription) hallucine
// régulièrement des mots en allemand/suédois/anglais sur du NL, ce qui pollue
// le scorer et le débrief. Deepgram en parallèle = transcription propre nl.
const DG_KEY = process.env.DEEPGRAM_API_KEY?.trim();

// ---------------------------------------------------------------------
// CORRECTIONS STT (copie locale de corrigerTranscription de server.js)
// ---------------------------------------------------------------------
function corrigerTranscription(texte) {
    let t = texte;
    t = t.replace(/\b(koffie\s*dis[ei][sz]?|koffie\s*dies|koffi\s*dis|cofides|confidis|kofidies|kofidis|koffinis|cofidies|coffee\s*dis|koffiedis|koffie\s*niece|koffinies|covidis|kovidis|cofedis|coffidis|cofidi)\b/gi, 'Cofidis');
    t = t.replace(/\bkoffie\b(?=\s+belgi)/gi, 'Cofidis');
    t = t.replace(/\bappelstaartje\b/gi, '@');
    t = t.replace(/\s+at\s+/g, '@');
    t = t.replace(/\bcreditcard(aanvraag)?\b/gi, 'kredietaanvraag');
    t = t.replace(/\bmaak\s*[ij]e?\s+uw\b/gi, 'mag ik uw');
    t = t.replace(/\bmaak\s*[ij]e?\s+ook\b/gi, 'mag ik ook');
    t = t.replace(/\bmaak\s*[ij]e?\b/gi, 'mag ik');
    // Deepgram entend parfois "uw" comme "naar mijn" / "naar uw" / "naar je" (fast speech).
    // Spécifique au contexte "mag ik [naar X]" pour rester safe.
    t = t.replace(/\bmag\s+ik\s+naar\s+(mijn|uw|je)\b/gi, 'mag ik uw');
    t = t.replace(/\bkan\s*[ij]e?\s+uw\b/gi, 'kunt u uw');
    t = t.replace(/\bkunnen\s+u\b/gi, 'kunt u');
    t = t.replace(/\bhebben\s+u\b/gi, 'heeft u');
    t = t.replace(/\b(direct|rijks|recht(streeks)?)\s*(register|registreer)\s*(nummer|nummers?)\b/gi, 'rijksregisternummer');
    t = t.replace(/\brigis\s*ter\s*(nummer)?\b/gi, 'rijksregisternummer');
    t = t.replace(/\bregister\s*nummer\b/gi, 'rijksregisternummer');
    t = t.replace(/\b(en\s+)?dat\s+is\s+je\b/gi, (_, prefix) => (prefix || '') + 'wat is uw');
    return t;
}

// ---------------------------------------------------------------------
// CHAMPS DU DOSSIER CRÉDIT (copie locale d'ALL_CHAMPS de server.js)
// ---------------------------------------------------------------------
const ALL_CHAMPS = [
    { id: 'naam',                label: 'Naam + voornaam',              fr: 'Nom + Prénom' },
    { id: 'adres',               label: 'Adres',                        fr: 'Adresse complète' },
    { id: 'geboortedatum',       label: 'Geboortedatum',                fr: 'Date de naissance' },
    { id: 'rijksregisternummer', label: 'Rijksregisternummer',          fr: 'N° de registre national' },
    { id: 'identiteitskaart',    label: 'Kopie identiteitskaart (r/v)', fr: "Copie carte d'identité" },
    { id: 'kredietbedrag',       label: 'Kredietbedrag',                fr: 'Montant du crédit demandé' },
    { id: 'kredietdoel',         label: 'Doel van het krediet',         fr: 'But du crédit' },
    { id: 'burgerlijke_staat',   label: 'Burgerlijke staat',            fr: 'État civil' },
    { id: 'kinderen_ten_laste',  label: 'Kinderen ten laste + bijslag', fr: 'Enfants à charge + allocations' },
    { id: 'beroep_type',         label: 'Beroepssituatie',              fr: 'Situation professionnelle (type)' },
    { id: 'maandinkomen',        label: 'Maandelijks inkomen',          fr: 'Revenu mensuel net' },
    { id: 'bewijs_inkomen',      label: 'Bewijsdocument inkomen',       fr: 'Justificatif de revenu' },
];

function construireChamps(champsIds) {
    const out = [];
    for (const id of (champsIds || [])) {
        const c = ALL_CHAMPS.find(x => x.id === id);
        if (c) out.push({ ...c });
    }
    return out;
}

// =====================================================================
// "CERVEAU" — scénario aléatoire à chaque session
// =====================================================================
// On garde 2 personas FIXES (voix + nom + personnalité) mais on régénère
// à chaque appel toutes les autres données du dossier :
//   âge ±5, ville, adresse précise, situation familiale, métier,
//   geboortedatum, rijksregisternummer (checksum mod 97 valide),
//   maandinkomen, kredietbedrag, kredietdoel, bewijs_inkomen,
//   et le sous-ensemble de 7-8 champs à collecter.
// → Max rejouabilité avec 2 voix mémorables.
// =====================================================================

// ---------------------------------------------------------------------
// PERSONAS NIV 1 — base FIXE (voornaam, familienaam, voix, personnalité)
// ---------------------------------------------------------------------
const PERSONAS_NIV1 = {
    A: {
        id:           'A',
        voornaam:     'Jan',
        familienaam:  'Janssen',
        gender:       'M',
        ageBase:      67,
        styleParole:  "Hij praat heel langzaam, met een rustige Vlaamse uitspraak.",
        humeur:       "Je bent een vriendelijke, hartelijke grootvader. Je mag af en toe je kleinkinderen vermelden als het natuurlijk past. Als de gesprekspartner lang nadenkt, zeg je vriendelijk 'Neemt u gerust uw tijd, hoor.' Nooit negatieve opmerkingen.",
    },
    B: {
        id:           'B',
        voornaam:     'Maria',
        familienaam:  'Peeters',
        gender:       'F',
        ageBase:      72,
        styleParole:  "Zij praat heel langzaam, met een zachte stem.",
        humeur:       "Je bent een zachte, geduldige grootmoeder. Je hoort soms wat minder goed, dus af en toe zeg je 'Hoe zei u dat?' of 'Pardon, kunt u dat herhalen?'. Als de gesprekspartner aarzelt, moedig je aan: 'Neemt u uw tijd, ik luister.' Zeer welwillend.",
    },
};

const COMPORTEMENT_NIV1 = "NIVEAU 1 — ZEER WELWILLEND : Je spreekt heel langzaam, articuleert duidelijk. Als de gesprekspartner aarzelt of een vraag stuntelig formuleert, wacht je geduldig. Als de vraag echt onduidelijk is, mag je suggereren 'Bedoelt u misschien...?'. Je spreekt nog wat trager als de gesprekspartner duidelijk niet-Nederlandstalig klinkt.";

// ---------------------------------------------------------------------
// POOLS de tirage (Vlaanderen — toutes les villes sont néerlandophones)
// ---------------------------------------------------------------------
const VILLES_VLAAMS = [
    { nom: 'Gent',      cp: '9000', straten: ['Korenlei', 'Sint-Pietersnieuwstraat', 'Brabantdam', 'Vrijdagmarkt', 'Koning Albertlaan', 'Lange Kruisstraat', 'Burgstraat', 'Phoenixstraat'] },
    { nom: 'Leuven',    cp: '3000', straten: ['Bondgenotenlaan', 'Diestsestraat', 'Tiensestraat', 'Naamsestraat', 'Brusselsestraat', 'Mechelsestraat', 'Parijsstraat'] },
    { nom: 'Antwerpen', cp: '2000', straten: ['Meir', 'Lange Lozanastraat', 'Frankrijklei', 'De Keyserlei', 'Lange Gasthuisstraat', 'Schuttershofstraat', 'Volkstraat'] },
    { nom: 'Brugge',    cp: '8000', straten: ['Steenstraat', 'Langestraat', 'Smedenstraat', 'Wollestraat', 'Geldmuntstraat', 'Hauwerstraat'] },
    { nom: 'Mechelen',  cp: '2800', straten: ['IJzerenleen', 'Bruul', 'Befferstraat', 'Hoogstraat', 'Sint-Katelijnestraat'] },
    { nom: 'Hasselt',   cp: '3500', straten: ['Demerstraat', 'Koning Albertstraat', 'Maastrichterstraat', 'Bampslaan'] },
    { nom: 'Kortrijk',  cp: '8500', straten: ['Doorniksestraat', 'Lange Steenstraat', 'Voorstraat', 'Sint-Maartenskerkhof'] },
];

const SITUATIES_FAM_M = [
    { id: 'gehuwd',     label_nl: 'gehuwd',     label_fr: 'Marié'     },
    { id: 'weduwnaar',  label_nl: 'weduwnaar',  label_fr: 'Veuf'      },
    { id: 'gescheiden', label_nl: 'gescheiden', label_fr: 'Divorcé'   },
];
const SITUATIES_FAM_F = [
    { id: 'gehuwd',     label_nl: 'gehuwd',     label_fr: 'Mariée'    },
    { id: 'weduwe',     label_nl: 'weduwe',     label_fr: 'Veuve'     },
    { id: 'gescheiden', label_nl: 'gescheiden', label_fr: 'Divorcée'  },
];

// Métiers plausibles pour 62-77 ans — pondérés (gepensioneerd domine).
const BEROEPEN_SENIOR = [
    { id: 'gepensioneerd',     weight: 6, label_nl: 'gepensioneerd',     label_fr: 'Retraité',           inkomenMin: 1100, inkomenMax: 1800, docs: ['een bankafschrift met de laatste pensioenstorting', 'een pensioenfiche van de Federale Pensioendienst'] },
    { id: 'arbeidsongeschikt', weight: 2, label_nl: 'arbeidsongeschikt', label_fr: 'Invalide',           inkomenMin: 1150, inkomenMax: 1750, docs: ['een attest van mijn mutualiteit', 'een attest van arbeidsongeschiktheid'] },
    { id: 'werkloze',          weight: 1, label_nl: 'werkloos',          label_fr: 'Au chômage',         inkomenMin: 1100, inkomenMax: 1500, docs: ['een attest van werkloosheid van de RVA'] },
    { id: 'bediende',          weight: 1, label_nl: 'bediende',          label_fr: 'Employé(e) actif',   inkomenMin: 2200, inkomenMax: 3400, docs: ['een loonfiche van de voorbije maand', 'mijn drie laatste loonbrieven'] },
];

const KREDIETDOELEN_NIV1 = [
    { id: 'auto',             label_nl: 'een autokrediet voor een nieuwe wagen',           bedragMin:  8000, bedragMax: 22000 },
    { id: 'renovatie_keuken', label_nl: 'een renovatiekrediet voor mijn keuken',           bedragMin: 10000, bedragMax: 28000 },
    { id: 'renovatie_badk',   label_nl: 'een renovatiekrediet voor mijn badkamer',         bedragMin:  7000, bedragMax: 18000 },
    { id: 'reis',             label_nl: 'een persoonlijk krediet voor een lange reis',     bedragMin:  4000, bedragMax: 10000 },
    { id: 'meubels',          label_nl: 'een krediet voor nieuwe meubels',                 bedragMin:  3000, bedragMax:  8000 },
    { id: 'verbouwing',       label_nl: 'een verbouwingskrediet voor de zolder',           bedragMin: 12000, bedragMax: 25000 },
    { id: 'medisch',          label_nl: 'een krediet voor een medische ingreep',           bedragMin:  5000, bedragMax: 14000 },
];

// Champs toujours requis (cœur d'un dossier crédit) vs optionnels (pour varier).
// kinderen_ten_laste EXCLU au niv 1 : les retraités n'ont quasi jamais d'enfants à charge,
// ça crée des dialogues bizarres ("0 kinderen, geen bijslag"). À réintégrer aux niveaux 2+.
const CHAMPS_REQUIS_BASE = ['naam', 'adres', 'beroep_type', 'maandinkomen', 'bewijs_inkomen'];
const CHAMPS_OPTIONNELS  = ['geboortedatum', 'rijksregisternummer', 'identiteitskaart', 'kredietbedrag', 'kredietdoel', 'burgerlijke_staat'];

const MOIS_NL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];

// ---------------------------------------------------------------------
// HELPERS aléatoires
// ---------------------------------------------------------------------
function pickOne(arr)     { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pickN(arr, n) {
    const c = [...arr];
    const out = [];
    for (let i = 0; i < n && c.length; i++) {
        out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]);
    }
    return out;
}
function pickWeighted(arr) {
    const total = arr.reduce((s, x) => s + (x.weight || 1), 0);
    let r = Math.random() * total;
    for (const x of arr) {
        r -= (x.weight || 1);
        if (r <= 0) return x;
    }
    return arr[arr.length - 1];
}
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Rijksregisternummer belge avec checksum mod 97 valide.
// Format : YY.MM.DD-XXX.CC où CC = 97 - (YYMMDDXXX mod 97) (pre-2000)
// ou CC = 97 - (2YYMMDDXXX mod 97) pour les naissances ≥ 2000.
function genererRRN(jaar, maand, dag) {
    const yyStr  = String(jaar % 100).padStart(2, '0');
    const mmStr  = String(maand).padStart(2, '0');
    const ddStr  = String(dag).padStart(2, '0');
    const seqStr = String(randInt(1, 997)).padStart(3, '0');
    let baseNum  = parseInt(yyStr + mmStr + ddStr + seqStr, 10);
    if (jaar >= 2000) baseNum += 2000000000;
    let checksum = 97 - (baseNum % 97);
    if (checksum === 0) checksum = 97;
    return `${yyStr}.${mmStr}.${ddStr}-${seqStr}.${String(checksum).padStart(2, '0')}`;
}

// Date de naissance plausible pour un âge donné (jour/mois aléatoires).
function genererDateNaissance(age) {
    const annee  = new Date().getFullYear() - age;
    const maand  = randInt(1, 12);
    const joursMax = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const dag    = randInt(1, joursMax[maand - 1]);
    return { jaar: annee, maand, dag };
}

// ---------------------------------------------------------------------
// GENERER LE SCENARIO complet à partir d'un persona de base
// ---------------------------------------------------------------------
function genererScenario(persona) {
    // 1. Âge ±5 ans autour de l'âge de référence du persona
    const age = randInt(persona.ageBase - 5, persona.ageBase + 5);

    // 2. Date de naissance + RRN cohérents
    const gebDate          = genererDateNaissance(age);
    const geboortedatumNL  = `${gebDate.dag} ${MOIS_NL[gebDate.maand - 1]} ${gebDate.jaar}`;
    const rrn              = genererRRN(gebDate.jaar, gebDate.maand, gebDate.dag);

    // 3. Ville + adresse précise (rue + numéro + CP + ville)
    const ville  = pickOne(VILLES_VLAAMS);
    const adres  = `${pickOne(ville.straten)} ${randInt(1, 250)}, ${ville.cp} ${ville.nom}`;

    // 4. Situation familiale (selon genre)
    const sitFam = pickOne(persona.gender === 'F' ? SITUATIES_FAM_F : SITUATIES_FAM_M);

    // 5. Métier (pondéré) + inkomen + bewijs cohérent
    const beroep      = pickWeighted(BEROEPEN_SENIOR);
    const inkomen     = Math.round(randInt(beroep.inkomenMin, beroep.inkomenMax) / 10) * 10; // arrondi 10€
    const bewijsDoc   = pickOne(beroep.docs);

    // 6. But + montant du crédit
    const krediet       = pickOne(KREDIETDOELEN_NIV1);
    const kredietBedrag = Math.round(randInt(krediet.bedragMin, krediet.bedragMax) / 500) * 500; // arrondi 500€

    // 7. Liste de champs à collecter : 5 toujours + 2 ou 3 bonus aléatoires = 7 ou 8 champs
    const champsIds = [...CHAMPS_REQUIS_BASE, ...pickN(CHAMPS_OPTIONNELS, randInt(2, 3))];

    return {
        age, ville: ville.nom, adres,
        geboortedatum: gebDate, geboortedatumNL,
        rrn, situationFam: sitFam,
        beroep, inkomen, bewijsDoc,
        krediet, kredietBedrag,
        champsIds,
    };
}

// ---------------------------------------------------------------------
// SYSTEM INSTRUCTION (Vlaams + rôle client + dossier généré)
// ---------------------------------------------------------------------
function buildSystemInstruction(persona, scenario, userName, userGender, champsRequis) {
    const nomConseiller   = userName || 'de medewerker';
    const titreConseiller = userGender === 'F' ? 'mevrouw' : 'meneer';
    const champsListe     = champsRequis.map(c => `${c.id} (${c.fr})`).join(', ');
    const titreClient     = persona.gender === 'F' ? 'Mevrouw' : 'Meneer';
    const nomClient       = `${titreClient} ${persona.familienaam}`;

    return `
🇧🇪 TAAL — VLAAMS / BELGISCH NEDERLANDS
Je spreekt UITSLUITEND Vlaams (Belgisch Nederlands), NOOIT Hollands Nederlands.
- Gebruik typisch Vlaamse uitdrukkingen waar het natuurlijk past: 'allee', 'zeker en vast', 'goesting' (i.p.v. 'zin'), 'amai', 'ge/gij' bij gemoedelijk taalgebruik, 'kunt ge', 'hebt ge', 'wablieft?' (i.p.v. 'wat zei u?').
- Voor zakelijke beleefdheid blijf je toch bij 'u' (u-vorm), zoals een Vlaamse oudere persoon dat aan de telefoon doet.
- VERMIJD STRIKT Hollandse uitdrukkingen: 'hartstikke', 'gezellig', 'lekker' (in figuurlijke zin), 'joh', 'tof' (in Hollandse betekenis), 'doei', 'hoi'. Gebruik in plaats daarvan: 'heel goed', 'fijn', 'aangenaam', 'dag', 'tot ziens'.
- Uitspraak: Vlaamse zachte 'g', heldere klinkers, geen sterke Randstadintonatie.
- Telefoonbegroeting Vlaams NEUTRAAL (ZONDER je naam te zeggen): zeg gewoon "Ja, hallo, met wie spreek ik?" — niets meer.
  ⚠️ Je zegt je naam NIET bij het opnemen — ook al is dat Belgisch gebruik. De medewerker MOET je vragen wie je bent (dat is een van de leerdoelen). Wacht tot hij/zij ernaar vraagt.

⭐ CONTEXTE — WIE BELT WIE EN WAAROM (lees dit eerst, het kadert het hele gesprek)
- JIJ bent de KLANT (${nomClient}).
- DE PERSOON DIE JE BELT is ${nomConseiller}, een medewerker van **COFIDIS** (een Belgische kredietmaatschappij — uitgesproken "ko-FI-dis").
- ENKELE WEKEN GELEDEN heb JIJ zelf een kredietaanvraag ingediend bij Cofidis. Vandaag belt Cofidis je op omdat er nog informatie ontbreekt in je dossier en ze willen die telefonisch vervolledigen.
- ALS de medewerker zich voorstelt met "Met X van Cofidis" / "X van de firma Cofidis" / een variant (zelfs uitgesproken als "covidis", "kofidis"…) → reageer natuurlijk en welwillend ("Ja, goedendag meneer/mevrouw" of "Ja, dag, ik luister"). Je herkent meteen Cofidis als de instelling waarbij je een dossier hebt — JE bent NIET verbaasd dat ze bellen, je verwachtte dit gesprek.
- ALS de medewerker een variant van Cofidis uitspreekt door slechte uitspraak (covidis, kofidis, koffiedis…) → reageer alsof hij "Cofidis" gezegd heeft. Verbeter hem niet, vraag niet om herhaling om die reden.

⭐ ROL
Je speelt de rol van ${nomClient}, ${scenario.age} jaar, ${scenario.beroep.label_nl} in ${scenario.ville}.
JE VOLLEDIGE NAAM IS: ${persona.voornaam} ${persona.familienaam}
- Voornaam : ${persona.voornaam}
- Familienaam : ${persona.familienaam}

⭐⭐ JOUW DOSSIER — DE FEITEN (gebruik ALTIJD precies deze waarden, verzin NOOIT andere)
Dit is jouw echte situatie. Wanneer de medewerker je iets vraagt, antwoord je op basis van deze gegevens en GEEN andere :
- Voornaam : ${persona.voornaam}
- Familienaam : ${persona.familienaam}
- Leeftijd : ${scenario.age} jaar
- Geboortedatum : ${scenario.geboortedatum.dag} ${MOIS_NL[scenario.geboortedatum.maand - 1]} ${scenario.geboortedatum.jaar}  ← spel VOLUIT in het Nederlands (bv. "drie april negentienhonderdzevenenvijftig")
- Adres : ${scenario.adres}  ← geef straat + huisnummer + postcode + gemeente, en spel cijfers voluit uit
- Rijksregisternummer : ${scenario.rrn}  ← lees EERST in natuurlijke groepen (de drie paren als jaartal/maand/dag, dan de 3 cijfers als één getal, dan de 2 cijfers als één getal). Voor de fallback bij onbegrip : zie regel 5b hieronder.
- Burgerlijke staat : ${scenario.situationFam.label_nl}
- Beroepssituatie : ${scenario.beroep.label_nl}
- Maandelijks netto inkomen / pensioen : ${scenario.inkomen} euro  ← spel VOLUIT in het Nederlands (bv. "duizend driehonderd vijftig euro")
- Bewijsdocument voor je inkomen : ${scenario.bewijsDoc}
- Doel van het krediet : ${scenario.krediet.label_nl}
- Aangevraagd kredietbedrag : ${scenario.kredietBedrag} euro  ← spel VOLUIT in het Nederlands
- Kinderen ten laste : geen (je kinderen zijn al volwassen / je hebt er geen meer ten laste)
- Identiteitskaart : bevestig dat je een kopie (recto/verso) kan opsturen

⚠️ Deze gegevens zijn je waarheid. Als de medewerker bv. vraagt "in welke stad woont u?", antwoord je "${scenario.ville}". Verzin NOOIT een andere stad, ander adres, ander bedrag, andere geboortedatum.

⭐ FUNDAMENTELE REGEL — Je bent een COÖPERATIEVE KLANT. Het is in je eigen belang om dit dossier af te ronden om je krediet te krijgen. Je antwoordt ALTIJD op alle vragen, zonder weigering of ontwijking. Zelfs als een vraag gaat over je inkomen, je adres, je gezinssituatie of een ander persoonlijk onderwerp — je beantwoordt die verplicht. Zeg NOOIT 'dat gaat u niet aan' of 'dat wil ik niet zeggen'.

⚠️ JE BENT DE KLANT, NIET DE MEDEWERKER:
Je stelt NOOIT vragen over het dossier, de te leveren documenten, het kredietbedrag, de voorwaarden, de Cofidis-procedures of wat dan ook over het krediet. Je antwoordt UITSLUITEND op wat de medewerker je vraagt. Als je geneigd bent een vraag over het dossier of het krediet te stellen, vervang die dan door een korte neutrale reactie ('Oké.', 'Ik begrijp het.', 'Goed.') en wacht op de volgende vraag.

⚠️ STRIKTE ANTWOORDREGEL:
Je geeft NOOIT spontaan of proactief informatie. Elke informatie moet expliciet gevraagd worden door de medewerker. Geef ALLEEN wat gevraagd wordt, niets meer. Anticipeer NIET op volgende vragen.

SPREEKSTIJL : ${persona.styleParole}
GEDRAG : ${COMPORTEMENT_NIV1}
HUMEUR EN PERSOONLIJKHEID : ${persona.humeur}

VELDEN DIE DE MEDEWERKER MOET VERZAMELEN (in willekeurige volgorde): ${champsListe}

REGEL VAN HERHALING:
Als de medewerker zegt 'kunt u herhalen', 'sorry?', 'pardon?', 'wablieft?' of een variant die aangeeft dat hij/zij het niet verstaan heeft: herhaal de informatie die je net gaf, lichtjes anders geformuleerd en langzamer.

⭐⭐ REGEL VAN BEGRIPSVERIFICATIE (KRITIEKE VELDEN) — ESSENTIEEL VOOR HET LEERPROCES
De medewerker leert Nederlands. Voor de volgende KRITIEKE VELDEN MOET je SYSTEMATISCH controleren of de medewerker je antwoord goed begrepen heeft, in vier stappen:

KRITIEKE VELDEN:
- naam (familienaam) en voornaam
- adres (straat, huisnummer, postcode, gemeente)
- geboortedatum (dag, maand, jaar — voluit in het Nederlands)
- rijksregisternummer (11 cijfers — EERST in natuurlijke groepen JJ.MM.DD - XXX . CC ; cijfer-per-cijfer alleen als fallback bij onbegrip)
- maandinkomen / pensioen / kredietbedrag / kinderbijslag (alle bedragen in euro, voluit in het Nederlands)

PROTOCOL IN 4 STAPPEN (uitsluitend voor de bovenstaande velden):
1. Je geeft de informatie heel langzaam en duidelijk.
2. Je vraagt onmiddellijk om de informatie te HERHALEN, zoals: 'Kunt u dat eens herhalen, om zeker te zijn dat u het goed begrepen heeft?' of 'Kunt u dat nog eens zeggen, om te controleren?' of 'Wat heeft u genoteerd?'.
3. De medewerker herhaalt wat hij/zij heeft begrepen.
4a. Als de medewerker CORRECT herhaalt → bevestig kort en warm: 'Ja, dat klopt helemaal.' / 'Perfect, dat is juist.' / 'Inderdaad, helemaal correct.'
4b. Als de medewerker FOUT of ONVOLLEDIG herhaalt → corrigeer vriendelijk en herhaal de informatie ZELF, nog langzamer en duidelijker. Vraag opnieuw om te herhalen ('Probeer nog eens?'). Doe dit tot de medewerker het correct heeft. Word NOOIT ongeduldig.

⚠️ DEZE STAP IS VERPLICHT VOOR KRITIEKE VELDEN — SLA HEM NOOIT OVER.
⚠️ VOOR DE ANDERE VELDEN (beroep_type, burgerlijke_staat, kredietdoel, documenten, e-mailadres) : geen verplichte herhalingsstap, korte antwoorden volstaan.

STRIKTE REGELS:
0. Jij bent de KLANT. ${nomConseiller} is de Cofidis-medewerker die jou belt. Je noemt hem/haar UITSLUITEND 'u' of '${titreConseiller}' — nooit bij familienaam. Je raadt nooit zijn/haar familienaam. Gebruik NOOIT je eigen familienaam om hem/haar aan te spreken.
1. Herhaal NOOIT spontaan een informatie die je al gegeven hebt.
2. Verwar de velden niet: als de medewerker om je identiteitskaart vraagt, geef je NIET je rijksregisternummer.
3. Vraagt de medewerker vaag om 'een document' zonder te preciseren? Antwoord direct met 'Over welk document gaat het precies?' — zonder de zin te parafraseren.
4. Noemt de medewerker een specifiek document (loonstrook, bankafschrift, identiteitskaart, aanslagbiljet, rekeninguittreksel...)? Bevestig kort dat je dat kan opsturen ('Dat is geen probleem. Dat stuur ik u op.').
   ⚠️ Vraag het e-mailadres alleen als alle documentvelden (identiteitskaart, bewijs_inkomen) genoemd zijn of dit het laatste documentveld is.
5. Geeft de medewerker een e-mailadres (je hoort '@' of 'apenstaartje')? Bevestig dat je alle documenten naar dat adres stuurt.
5b. Voor 'rijksregisternummer': GEBRUIK het nummer uit jouw dossier hierboven (${scenario.rrn}), NOOIT een ander.
   ⚠️ LEESSTIJL VAN HET RRN — IN TWEE STAPPEN :
   STAP 1 (eerste keer, NATUURLIJK Belgisch gebruik) : lees in groepen, NIET cijfer per cijfer. De drie eerste paren = geboortedatum (jaar/maand/dag) als getallen, dan de drie cijfers van de volgnummer als één getal, dan de twee controlecijfers als één getal.
   Bv. voor "76.08.20-843.12" zeg je : "zesenzeventig, nul acht, twintig — achthonderd drieënveertig — twaalf."
   Voor JOUW nummer (${scenario.rrn}) → groepeer en lees op die manier, met korte pauzes tussen de groepen.
   STAP 2 (alleen als de medewerker 'kunt u herhalen', 'sorry?', 'wablieft?' of een variant zegt, OF als hij/zij het verkeerd herhaalt) : NU pas spel je cijfer per cijfer, nog langzamer ('zeven, zes — punt — nul, acht — punt — twee, nul — koppelteken — acht, vier, drie — punt — één, twee'). Dat is de fallback voor onbegrip.
5c. Voor datums EN bedragen in euro: schrijf ALTIJD voluit in het Nederlands. Bijv. 'drie april negentienhonderd zeven en vijftig', 'tweeduizend driehonderd vijftig euro'. Geen cijfers uitspreken.
6. Voor 'beroep_type': antwoord '${scenario.beroep.label_nl}'. Voor 'maandinkomen': geef precies ${scenario.inkomen} euro, voluit in het Nederlands uitgesproken.
7. Voor 'kredietdoel': antwoord '${scenario.krediet.label_nl}'. Voor 'kredietbedrag': geef precies ${scenario.kredietBedrag} euro, voluit in het Nederlands.
8. Voor 'bewijs_inkomen': vermeld dat je '${scenario.bewijsDoc}' kan opsturen, en vraag het e-mailadres als het nog niet gegeven is.
10. Beoordeel niet de uitspraak van eigennamen of Franse woorden (Cofidis, Belgische namen) — dat is niet relevant.

⭐ HOE BEGIN JE HET GESPREK
Wanneer het gesprek begint (je hoort de telefoon rinkelen) → JE MOET METEEN HARDOP SPREKEN. Stilte is NOOIT toegestaan bij het opnemen.
✅ Zeg PRECIES : "Ja, hallo, met wie spreek ik?" — en STOP daar. Niets meer.
❌ ZEG JE NAAM NIET. Niet je voornaam, niet je familienaam — ook al is dat Belgisch gebruik. Wacht tot de medewerker je expliciet vraagt 'Met wie spreek ik?' of 'Mag ik uw naam?'. DAN pas geef je naam EN voornaam (dat is een leerdoel : de medewerker moet leren naar je naam vragen).
Na je begroeting → WACHT je geduldig tot de medewerker zich voorstelt en je vraagt stelt. Geef nooit ongevraagd informatie. Maar de eerste begroeting MOET er zijn, anders denkt de medewerker dat de lijn niet werkt.
`;
}

// ---------------------------------------------------------------------
// WAV encoder — encapsule des chunks PCM 16kHz mono Int16 LE en WAV valide
// (header RIFF 44 bytes). Utilisé pour envoyer l'audio user accumulé à
// Gemini multimodal dans le débrief.
// ---------------------------------------------------------------------
function buildWavBuffer(pcmChunks, { sampleRate = 16000, numChannels = 1, bitsPerSample = 16 } = {}) {
    const dataSize     = pcmChunks.reduce((acc, c) => acc + c.length, 0);
    const byteRate     = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign   = numChannels * bitsPerSample / 8;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);       // ChunkSize
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);                 // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20);                  // AudioFormat = PCM
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, ...pcmChunks], 44 + dataSize);
}

// ---------------------------------------------------------------------
// APPEL GEMINI REST (scorer + débrief) avec retry 503/429
// ---------------------------------------------------------------------
async function appelGeminiREST(geminiKey, body, options = {}) {
    const { model = SCORER_MODEL, timeoutMs = 15000, maxRetries = 2 } = options;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (res.status === 503 || res.status === 429) {
                if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2500 * attempt)); continue; }
                throw new Error(`HTTP ${res.status} après ${maxRetries} tentatives [${model}]`);
            }
            if (!res.ok) {
                const err = await res.text();
                console.error(`❌ [REST ${model}] HTTP ${res.status} body : ${err.slice(0, 1500)}`);
                throw new Error(`HTTP ${res.status} [${model}] : ${err.slice(0, 300)}`);
            }
            return await res.json();
        } catch (e) {
            clearTimeout(timeoutId);
            if (attempt < maxRetries && e.name !== 'AbortError') {
                console.warn(`⚠️ [REST ${model}] tentative ${attempt}/${maxRetries} échec (${e.message}) — retry…`);
                await new Promise(r => setTimeout(r, 2500 * attempt)); continue;
            }
            throw e;
        }
    }
}

// Extraction JSON robuste : gère les fences ```json ... ``` éventuelles
// et les commentaires/notes que certains modèles ajoutent autour.
function extraireJSON(rawText) {
    let t = rawText.trim();
    // Strip markdown code fences
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    // Garde uniquement du premier { au dernier }
    const first = t.indexOf('{');
    const last  = t.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) t = t.substring(first, last + 1);
    return JSON.parse(t);
}

// ---------------------------------------------------------------------
// SCORER side-channel : analyse le dernier tour, met à jour la checklist,
// retourne ending_signal pour décider de la phase goodbye.
// ---------------------------------------------------------------------
async function scoreLastTurn(geminiKey, historique, champsRequis, champsRemplis, userName) {
    const idsDispo  = champsRequis.map(c => c.id).join(', ');
    const remplis   = champsRemplis.length ? champsRemplis.join(', ') : 'aucun';
    const restants  = champsRequis.filter(c => !champsRemplis.includes(c.id)).map(c => c.id).join(', ') || '— tous remplis';

    const dernier = historique.slice(-1)[0] || {};
    const userTr  = dernier.user || '';
    const aiTr    = dernier.ai   || '';

    const scoringPrompt = `
Tu es un évaluateur côté serveur d'un simulateur de conversation NL-BE.
${userName || 'Le conseiller'} (qui apprend le néerlandais) parle au client. Tu observes la conversation et tu décides :
1. Si la DERNIÈRE réplique du conseiller a fait avancer le dossier → quel champ_rempli marquer ?
2. Si la conversation est arrivée à sa conclusion naturelle (au revoir mutuels) → ending_signal.

⚠️ La transcription du conseiller vient de Deepgram nova-2 (NL). Elle est généralement propre mais peut comporter des erreurs mineures sur des mots composés ou rares. Déduis l'INTENTION à partir du contexte : la réponse du client est le meilleur indice — si le client donne une info précise, c'est que le conseiller a bien posé la question correspondante.

⚠️ Pour le champ "correction" : ne propose une correction QUE si tu vois une vraie erreur grammaticale ET si ta correction PRÉSERVE l'intention exacte de la question. Ne remplace JAMAIS une question par une question différente (par ex. "Mag ik uw voornaam hebben?" → ne PAS proposer "Mag ik u bij de voornaam noemen?", c'est une autre question). En cas de doute, correction = null.

⚠️⚠️ RÈGLE EMAIL — STRICTE (ne JAMAIS contourner) :
"bewijs_inkomen" et "identiteitskaart" sont des **champs documents**. Ils ne peuvent PAS être marqués champ_rempli juste parce que le conseiller MENTIONNE le document ou demande à le recevoir. Pour qu'ils soient validés, DEUX conditions sont requises EN MÊME TEMPS :
  (a) la cliente CONFIRME explicitement qu'elle peut envoyer le document ("ja, dat stuur ik op", "ja zeker", "geen probleem", "ik kan dat opsturen"…), ET
  (b) un adresse email a été échangée dans la conversation — concrètement, tu DOIS voir le caractère "@" OU le mot "apenstaartje" OU le motif "<naam>.<dienst>.<be|com|nl>" (ex: "david punt cofidis punt be") dans le tour courant ou un tour récent.
Si la cliente confirme MAIS pas d'email encore → champ_rempli = null. On attend que l'email soit donné.
Si l'email est donné MAIS la cliente n'a pas confirmé l'envoi → champ_rempli = null.
ATTENTION aux artefacts Deepgram qui peuvent perdre le "@" : si tu vois quelque chose comme "<prenom> punt <firma> punt be" ou "<prenom><firma> be" (sans @), considère que c'est un email cassé par STT et accepte SEULEMENT si la cliente a aussi explicitement confirmé. En cas de doute : null.
⚠️ RÈGLE KINDEREN : "kinderen_ten_laste" nécessite DEUX infos (nombre d'enfants + montant kinderbijslag).

⚠️⚠️ RÈGLE VALIDATION PAR RÉPÉTITION (CRITIQUE — pédagogique) :
Les champs suivants sont des "champs critiques" : naam, adres, geboortedatum, rijksregisternummer, maandinkomen, kredietbedrag, kinderen_ten_laste (partie montant kinderbijslag).
Pour ces champs, le client donne d'abord l'info, PUIS demande au conseiller de répéter, PUIS confirme avec une phrase du type "Ja, dat klopt" / "Perfect, dat is juist" / "Inderdaad" / "Helemaal correct".
→ Ne marque le champ comme "champ_rempli" QUE quand tu vois cette CONFIRMATION du client dans le DERNIER tour (ou très récente dans l'historique).
→ Si le client vient juste de donner l'info SANS confirmation ("Mijn naam is Janssen. Kunt u dat herhalen?") → champ_rempli = null, on attend la validation.
→ Si le conseiller a mal répété et que le client a corrigé sans confirmer ("Bijna! Het is eigenlijk Janssen, met dubbele s.") → champ_rempli = null, on attend que le conseiller répète correctement.
→ Pour les AUTRES champs non critiques (beroep_type, burgerlijke_staat, kredietdoel, documents, e-mail) : pas besoin d'attendre la confirmation, marquer dès que l'info est donnée comme avant.

CHAMPS POSSIBLES : ${idsDispo}
CHAMPS DÉJÀ REMPLIS : ${remplis}
CHAMPS RESTANTS : ${restants}

DERNIER TOUR :
${userName || 'Conseiller'} (NL) : "${userTr}"
Client (NL) : "${aiTr}"

HISTORIQUE RÉCENT (8 derniers tours) :
${historique.slice(-8).map((t, i) => `[${i+1}] ${userName || 'Conseiller'}: "${t.user}"\n    Client: "${t.ai}"`).join('\n')}

RÉPONDS UNIQUEMENT EN JSON :
{
  "champ_rempli": "<un id parmi ${idsDispo}> ou null",
  "correction":   "<correction en français du néerlandais du conseiller, ou null si NL correct>",
  "raison":       "<courte explication en français>",
  "ending_signal":"<accept | refuse | continue>"
}

ending_signal :
- "accept"   : le client vient de dire au revoir et tous les champs sont remplis → on peut clôturer.
- "refuse"   : il manque encore des champs, ne pas clôturer.
- "continue" : conversation en cours normale.
`.trim();

    const data = await appelGeminiREST(geminiKey, {
        contents: [{ parts: [{ text: scoringPrompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
    }, {
        timeoutMs: 25000,   // pics de latence Google fréquents en heures de pointe — on tolère 25s
        maxRetries: 2,
    });
    if (!data.candidates?.[0]?.content?.parts?.[0]) throw new Error('Scorer vide');
    return extraireJSON(data.candidates[0].content.parts[0].text);
}

// ---------------------------------------------------------------------
// DÉBRIEF pédagogique final — multimodal (texte + audio user inline)
//
// Si `userAudioWav` (Buffer WAV) est fourni → on appelle gemini-2.5-flash
// avec inlineData audio + prompt enrichi pour analyser l'accent réel.
// Sinon → fallback texte-only sur gemini-2.5-flash-lite (mode dégradé).
//
// La section "prononciation" passe d'une string à un objet structuré :
//   { global: string, erreurs: [{ mot, probleme, conseil }, ...] }  ← top 3
// Le frontend gère les 2 formats (rétro-compat).
// ---------------------------------------------------------------------
async function genererDebrief(geminiKey, historique, userName, userGender, userAudioWav = null) {
    const nomConseiller = userName || 'le conseiller';
    const transcriptStr = historique.map(t => `${nomConseiller}: "${t.user}"\nClient: "${t.ai}"`).join('\n');
    const hasAudio      = !!(userAudioWav && userAudioWav.length > 44); // > header seul

    const prononciationSchema = hasAudio
        ? `"prononciation": {
    "global": "1-2 phrases sur l'accent, le débit, l'intonation, les hésitations et l'assurance globale (basé sur l'ÉCOUTE de l'audio fourni, pas la transcription).",
    "erreurs": [
      { "mot": "mot ou expression NL exact entendu", "probleme": "décris ce que tu entends (ex: 'g prononcé à la française au lieu du g doux flamand', 'ij prononcé é au lieu de ay')", "conseil": "1 phrase concrète pour corriger" }
    ]
  }`
        : `"prononciation": "Feedback sur l'accent (difficultés typiques du NL : g, ij, eu, ui, r…). Si pas d'info suffisante, donne des conseils généraux."`;

    const audioInstructions = hasAudio
        ? `\n🎧 AUDIO FOURNI EN INLINE — c'est UNIQUEMENT la voix de ${nomConseiller} (apprenant) capturée pendant la session, en PCM 16kHz mono encapsulé WAV. La voix du client IA n'y est PAS. Écoute attentivement et fonde ta section "prononciation" sur ce que tu entends RÉELLEMENT, pas sur la transcription.
- Cible les difficultés classiques du néerlandais pour un francophone : g (doux flamand vs dur hollandais vs r/x à la française), ij/ei, eu, ui, oe, sch, r (roulé/uvulaire/gardé), accents toniques, intonation montante/descendante de la phrase, débit, longueur des voyelles.
- IGNORE la prononciation des mots propres français (Cofidis, prénoms/noms belges francisés) et des nombres en français.
- Identifie EXACTEMENT 3 erreurs précises (mot/expression réellement entendue dans l'audio) dans "erreurs". Si tu en entends moins de 3, mets-en moins. Si l'audio est trop court ou silencieux, mets []. N'invente JAMAIS une erreur que tu n'entends pas.\n`
        : '';

    const prompt = `Tu es un coach bienveillant spécialisé en néerlandais professionnel belge (Vlaams).
LANGUE DE RÉPONSE : FRANÇAIS UNIQUEMENT.
Tutoie ${nomConseiller}. Analyse UNIQUEMENT les lignes commençant par "${nomConseiller}:" dans le transcript.
NE commente PAS les mots propres français (Cofidis, noms belges) ni la prononciation de ceux-ci.
Sois encourageant(e) ET précis(e) — donne des exemples concrets tirés du transcript.
Si le transcript est très court (moins de 3 échanges), adapte ton analyse à ce qui est disponible.

⚠️ Les transcriptions de ${nomConseiller} viennent de Deepgram nova-2 (STT NL). Elles sont généralement propres, mais Deepgram peut occasionnellement fragmenter un mot composé ou mal entendre un mot. Reste prudent : si une phrase ressemble à du bruit ou contient un mot manifestement inexistant, ignore-la plutôt que d'inventer une "erreur" à partir d'elle. Dans le doute, mets [] pour grammaire/conjugaison.

⚠️⚠️ RÈGLE D'OR — PRÉSERVER L'INTENTION :
Avant de corriger une phrase, demande-toi : "quelle était l'INTENTION du conseiller ?" puis "la correction que je propose garde-t-elle exactement cette intention ?". Si NON → ne corrige PAS. Mieux vaut [] qu'une correction qui change le sens.
- Ne JAMAIS remplacer une question par une question DIFFÉRENTE. Si le conseiller demande "puis-je avoir votre prénom", ne propose pas "puis-je vous appeler par votre prénom" — c'est une autre question.
- Une formulation est CORRECTE même si tu la trouves lourde, datée ou inhabituelle, tant qu'elle est grammaticale et fait passer l'intention.
- Avant de noter une erreur, vérifie qu'elle ne pourrait pas s'expliquer par un mot mal entendu par Deepgram (ex: "naar mijn" pour "uw", "maak je" pour "mag ik", "dat is je" pour "wat is uw"). Si c'est plausible, mets [].

EXEMPLES DE FORMULATIONS PARFAITEMENT CORRECTES (NE PAS corriger) :
- "Mag ik uw voornaam hebben, alsjeblieft?" = "puis-je avoir votre prénom svp ?" → CORRECT, idiomatique. Ne PAS transformer en "Mag ik u bij de voornaam noemen?".
- "Mag ik uw adres weten?" / "Wat is uw adres?" / "Kunt u mij uw adres geven?" → toutes correctes.
- "Hoe heet u?" / "Wat is uw naam?" → toutes correctes.
${audioInstructions}
RÉPONDS UNIQUEMENT EN JSON valide, toutes les valeurs en français :
{
  "encouragement": "Message chaleureux de 2 phrases sur l'effort et le courage de pratiquer",
  "points_forts": [
    "point fort 1 avec exemple concret tiré du transcript",
    "point fort 2 avec exemple concret"
  ],
  "grammaire": [
    { "erreur": "phrase exacte mal formulée", "correction": "forme correcte", "explication": "règle en 1 phrase" }
  ],
  "conjugaison": [
    { "erreur": "forme utilisée", "correction": "forme correcte", "explication": "règle courte" }
  ],
  "vocabulaire": [
    { "mot_nl": "mot ou expression NL utile (Vlaams si possible)", "traduction": "traduction FR", "exemple": "exemple d'usage dans ce contexte crédit" },
    { "mot_nl": "...", "traduction": "...", "exemple": "..." },
    { "mot_nl": "...", "traduction": "...", "exemple": "..." }
  ],
  ${prononciationSchema},
  "phrase_modele": "Une question exemplaire en NL parfaitement formulée pour ce contexte crédit"
}
Règles : grammaire et conjugaison doivent avoir 1 à 3 entrées chacune (utilise [] si aucune erreur). vocabulaire doit avoir exactement 3 entrées.

Transcript :
${transcriptStr}`;

    // Construit la requête : multimodal si audio dispo, sinon texte-only.
    const parts = [{ text: prompt }];
    if (hasAudio) {
        parts.push({
            inlineData: {
                mimeType: 'audio/wav',
                data: userAudioWav.toString('base64'),
            },
        });
        const sizeMb = (userAudioWav.length / (1024 * 1024)).toFixed(2);
        console.log(`🎧 [realtime] Débrief multimodal — audio user ${sizeMb} MB envoyé à ${DEBRIEF_MODEL}.`);
    } else {
        console.log(`📝 [realtime] Débrief texte-only (pas d'audio user accumulé) — fallback ${SCORER_MODEL}.`);
    }

    const data = await appelGeminiREST(geminiKey, {
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json' },
    }, {
        model:      hasAudio ? DEBRIEF_MODEL : SCORER_MODEL,
        timeoutMs:  hasAudio ? 45000 : 15000,   // multimodal audio = + lent
        maxRetries: hasAudio ? 1 : 2,           // multimodal flaky → fail-fast vers fallback texte
    });
    if (!data.candidates?.[0]?.content?.parts?.[0]) {
        console.error('❌ [realtime] Réponse débrief sans candidate.parts. Réponse complète :', JSON.stringify(data).slice(0, 800));
        throw new Error('Debrief vide (pas de candidate)');
    }
    return extraireJSON(data.candidates[0].content.parts[0].text);
}

// =====================================================================
// SESSION par connexion frontend
// =====================================================================
function handleFrontendConnection(ws, geminiKey) {
    console.log('🟢 [realtime] Nouveau stagiaire connecté.');

    let liveWS          = null;   // WS vers Gemini Live
    let liveReady       = false;  // setupComplete reçu
    let currentProfil   = null;
    let userName        = '';
    let userGender      = 'M';
    let champsRequis    = [];
    let champsRemplis   = [];
    let goodbyePhase    = false;
    let isGameOver      = false;
    let scoring         = false;  // mutex pour le scorer
    let pendingDebrief  = false;  // débrief programmé après goodbye

    // Accumulateurs de transcription pour le tour en cours
    let currentUserTr = '';       // input_audio_transcription Live (bruité, sert juste à l'affichage live)
    let currentAiTr   = '';       // output_audio_transcription Live (propre)
    let dgUserTrBuffer = '';      // transcription Deepgram propre (source de vérité pour scorer/débrief)
    // Historique des tours [{user, ai}]
    const historique  = [];
    // Buffer audio entrant en attendant setupComplete
    const audioBufferBeforeReady = [];

    // Deepgram (transcription input propre en parallèle de Live)
    let dgConnection         = null;
    let dgConnecting         = false;
    let dgKeepAliveInterval  = null;

    // Audio user accumulé pour le débrief multimodal (PCM 16kHz mono Int16 LE).
    // On stocke les chunks bruts ; on les encapsule en WAV au moment du débrief.
    // Tronqué dès qu'on dépasse MAX_AUDIO_BYTES (~10 min) pour éviter l'OOM.
    let userAudioChunks   = [];
    let userAudioBytes    = 0;
    let userAudioTruncated = false;

    const safeSend = (payload) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    // -----------------------------------------------------------------
    // Ouvre la connexion Deepgram nl (transcription propre en parallèle)
    // -----------------------------------------------------------------
    const setupDeepgram = () => {
        if (!DG_KEY) {
            console.warn('⚠️ [realtime] DEEPGRAM_API_KEY manquante — fallback sur input_audio_transcription Live (bruité).');
            return;
        }
        if (dgConnecting) return;
        if (dgConnection && dgConnection.readyState === WebSocket.OPEN) return;
        dgConnecting = true;

        // Même combo que server.js (cascade) — combinaison validée par Deepgram.
        // `interim_results=true` + `vad_events=true` sont REQUIS pour que
        // `utterance_end_ms` soit accepté ; sinon HTTP 400 à l'upgrade WS.
        // On filtre nous-mêmes les non-`is_final` côté message handler.
        const dgUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=nl&interim_results=true&encoding=linear16&sample_rate=16000&endpointing=false&utterance_end_ms=3500&vad_events=true&keepalive=true&numerals=true`;
        dgConnection = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DG_KEY}` } });

        dgConnection.on('open', () => {
            console.log('✅ [realtime] Deepgram NL ouvert (parallèle).');
            dgConnecting = false;
            dgKeepAliveInterval = setInterval(() => {
                if (dgConnection?.readyState === WebSocket.OPEN) {
                    dgConnection.send(JSON.stringify({ type: 'KeepAlive' }));
                }
            }, 8000);
        });

        dgConnection.on('message', (data) => {
            try {
                const resp = JSON.parse(data);
                const tr = resp.channel?.alternatives?.[0]?.transcript;
                if (tr && resp.is_final) {
                    dgUserTrBuffer += ' ' + tr;
                }
            } catch { /* ignore */ }
        });

        dgConnection.on('error', (e) => {
            console.error('❌ [realtime] Deepgram WS error :', e.message);
        });

        dgConnection.on('close', () => {
            dgConnecting = false;
            dgConnection = null;
            if (dgKeepAliveInterval) { clearInterval(dgKeepAliveInterval); dgKeepAliveInterval = null; }
            console.log('⚠️ [realtime] Deepgram fermé.');
        });
    };

    // -----------------------------------------------------------------
    // Ouvre la connexion vers Gemini Live
    // -----------------------------------------------------------------
    const openLive = () => {
        const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${geminiKey}`;
        liveWS = new WebSocket(url);

        liveWS.on('open', () => {
            const voiceName = pickLiveVoice(currentProfil.persona.gender);
            console.log(`✅ [realtime] Gemini Live WS ouvert (modèle ${LIVE_MODEL}, voix ${voiceName} pour genre ${currentProfil.persona.gender}).`);

            const systemInstruction = buildSystemInstruction(
                currentProfil.persona,
                currentProfil.scenario,
                userName,
                userGender,
                champsRequis,
            );

            // ⚠️ Note: les modèles native-audio (preview-12-2025) auto-détectent
            // la langue à partir de l'audio + system_instruction et REFUSENT
            // un language_code explicite (close code 1007 'Unsupported language
            // code'). On compte donc 100% sur le system_instruction pour pousser
            // vers le Vlaams. À réessayer avec language_code si Google relâche
            // la contrainte côté API.
            const setupMsg = {
                setup: {
                    model: `models/${LIVE_MODEL}`,
                    generation_config: {
                        response_modalities: ['AUDIO'],
                        speech_config: {
                            voice_config: {
                                prebuilt_voice_config: { voice_name: voiceName },
                            },
                        },
                        temperature: 0.7,
                    },
                    system_instruction: {
                        parts: [{ text: systemInstruction }],
                    },
                    input_audio_transcription:  {},
                    output_audio_transcription: {},
                },
            };
            liveWS.send(JSON.stringify(setupMsg));
        });

        liveWS.on('message', (data) => {
            const raw = data.toString();
            try {
                const msg = JSON.parse(raw);
                // DEBUG : on logge la 1re frame complète pour voir ce que renvoie l'API
                if (!liveReady) {
                    console.log('📥 [realtime] 1re frame Live :', JSON.stringify(msg).slice(0, 600));
                }
                handleLiveMessage(msg);
            } catch (e) {
                console.error('❌ [realtime] Parse message Live :', e.message, '— raw:', raw.slice(0, 300));
            }
        });

        liveWS.on('error', (e) => {
            console.error('❌ [realtime] Gemini Live WS error :', e.message);
            safeSend({ type: 'error', value: 'live_ws_error: ' + e.message });
        });

        liveWS.on('unexpected-response', (req, res) => {
            // Cas typique : 404 si modèle inexistant, 403 si clé invalide
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                console.error(`❌ [realtime] Live HTTP ${res.statusCode} avant upgrade WS — body:`, body.slice(0, 600));
                safeSend({ type: 'error', value: `live_http_${res.statusCode}` });
            });
        });

        liveWS.on('close', (code, reason) => {
            const reasonStr = reason?.toString() || '';
            console.log(`⚠️ [realtime] Gemini Live WS fermé (code=${code}) reason="${reasonStr}"`);
            if (!liveReady) {
                safeSend({ type: 'error', value: `live_closed_before_ready_${code}` });
            }
            liveReady = false;

            // Fermeture inopinée en plein milieu de session (typiquement 1011
            // "Internal error" côté Google sur les modèles native-audio preview).
            // Si on a déjà de l'historique et qu'on n'est pas déjà en game over,
            // on sauve la session en déclenchant le débrief avec ce qu'on a.
            if (code !== 1000 && code !== 1005 && historique.length > 0 && !isGameOver) {
                console.log(`🆘 [realtime] Fermeture inopinée — sauvetage débrief avec ${historique.length} tour(s) accumulé(s).`);
                isGameOver = true;
                safeSend({ type: 'live_disconnected', code, reason: reasonStr });
                triggerDebrief();
            }
        });
    };

    // -----------------------------------------------------------------
    // Traitement des messages de Gemini Live
    // -----------------------------------------------------------------
    const handleLiveMessage = async (msg) => {
        // 1) setupComplete
        if (msg.setupComplete) {
            liveReady = true;
            console.log('✅ [realtime] setupComplete reçu.');
            safeSend({ type: 'ready' });

            // Flush le buffer audio accumulé pendant l'attente
            for (const chunk of audioBufferBeforeReady) {
                forwardAudioToLive(chunk);
            }
            audioBufferBeforeReady.length = 0;

            // Pousse l'IA à parler en premier (décroché téléphonique)
            // — petit text turn vide pour lancer la conversation côté client
            const kickoff = {
                client_content: {
                    turns: [{
                        role: 'user',
                        parts: [{ text: 'De telefoon rinkelt. JE MOET NU SPREKEN. Neem de telefoon op en zeg PRECIES deze ene zin, kort en vriendelijk Vlaams uitgesproken : "Ja, hallo, met wie spreek ik?". Niets meer, niets minder. Geef ABSOLUUT NIET je naam.' }],
                    }],
                    turn_complete: true,
                },
            };
            liveWS.send(JSON.stringify(kickoff));
            return;
        }

        // 2) serverContent — audio + transcriptions + turn complete
        if (msg.serverContent) {
            const sc = msg.serverContent;

            // 2a) Audio sortant (PCM 24kHz Int16 LE)
            if (sc.modelTurn?.parts) {
                let firstChunk = true;
                for (const part of sc.modelTurn.parts) {
                    const inline = part.inlineData;
                    if (inline?.data && inline?.mimeType?.startsWith('audio/')) {
                        if (firstChunk) {
                            safeSend({ type: 'audio_start' });
                            firstChunk = false;
                        }
                        safeSend({ type: 'audio_chunk', value: inline.data });
                    }
                }
            }

            // 2b) Transcription input (ce que dit l'utilisateur)
            if (sc.inputTranscription?.text) {
                currentUserTr += sc.inputTranscription.text;
                safeSend({ type: 'interim_text', value: currentUserTr, isFinal: false });
            }

            // 2c) Transcription output (ce que dit le client IA)
            if (sc.outputTranscription?.text) {
                currentAiTr += sc.outputTranscription.text;
                safeSend({ type: 'ai_interim', value: currentAiTr });
            }

            // 2d) Fin de tour
            if (sc.turnComplete) {
                safeSend({ type: 'audio_end' });

                // Source de vérité user = Deepgram (propre). Fallback Live si rien.
                const dgRaw = dgUserTrBuffer.trim();
                const userTr = dgRaw
                    ? corrigerTranscription(dgRaw)
                    : currentUserTr.trim();
                const aiTr   = currentAiTr.trim();

                if (dgRaw) {
                    console.log(`🗣️ [realtime] User (Deepgram) : "${userTr}"`);
                } else if (currentUserTr) {
                    console.log(`🗣️ [realtime] User (Live fallback) : "${currentUserTr.trim()}"`);
                }

                dgUserTrBuffer = '';
                currentUserTr  = '';
                currentAiTr    = '';

                if (userTr || aiTr) {
                    historique.push({ user: userTr, ai: aiTr });
                    safeSend({
                        type:  'turn_complete',
                        user:  userTr,
                        ai:    aiTr,
                    });

                    // Si l'utilisateur n'a rien dit ce tour (kickoff initial),
                    // on saute le scorer mais on garde le tour dans l'historique.
                    if (userTr && !scoring) {
                        scoreNow();
                    }
                }

                // Si on était en goodbye et qu'un nouveau tour complete arrive,
                // c'est le client qui a dit au revoir → on déclenche le débrief.
                if (goodbyePhase && !isGameOver) {
                    isGameOver = true;
                    setTimeout(() => triggerDebrief(), 1500);
                }
            }

            if (sc.interrupted) {
                safeSend({ type: 'interrupted' });
            }
        }
    };

    // -----------------------------------------------------------------
    // Scoring side-channel après chaque tour utilisateur
    // -----------------------------------------------------------------
    const scoreNow = async () => {
        scoring = true;
        try {
            const result = await scoreLastTurn(geminiKey, historique, champsRequis, champsRemplis, userName);

            if (result.champ_rempli
                && champsRequis.some(c => c.id === result.champ_rempli)
                && !champsRemplis.includes(result.champ_rempli)) {
                champsRemplis.push(result.champ_rempli);
                console.log(`✅ [realtime] ${result.champ_rempli} (${champsRemplis.length}/${champsRequis.length})`);
            }

            safeSend({
                type:        'ai_response',
                correction:  result.correction,
                champRempli: result.champ_rempli,
                reason:      result.raison,
                champsRemplis,
                totalChamps: champsRequis.length,
            });

            // Bascule en goodbye phase si :
            //  - tous les champs sont remplis,
            //  - OU le scorer renvoie ending_signal='accept'.
            if (!goodbyePhase
                && (champsRemplis.length >= champsRequis.length || result.ending_signal === 'accept')) {
                goodbyePhase = true;
                safeSend({ type: 'goodbye_phase' });
                console.log('🏁 [realtime] Phase goodbye activée.');
            }
        } catch (e) {
            // Le scorer peut timeout sur des pics de latence Google. Le tour suivant
            // re-déclenchera un scoring avec l'historique mis à jour — pas critique.
            console.warn('⚠️ [realtime] Scorer erreur (non bloquant, prochain tour rattrapera) :', e.message);
        } finally {
            scoring = false;
        }
    };

    // -----------------------------------------------------------------
    // Débrief final (game_over)
    // -----------------------------------------------------------------
    const triggerDebrief = async () => {
        if (pendingDebrief) return;
        pendingDebrief = true;

        // Encapsule l'audio user accumulé en WAV pour le débrief multimodal.
        // Si l'utilisateur n'a rien dit (kickoff seul), userAudioBytes peut être
        // très faible : on n'envoie l'audio que si > 1 s (>32000 bytes à 16kHz/16bit).
        const minBytes  = 16000 * 2 * 1; // 1 s
        const audioWav  = userAudioBytes >= minBytes
            ? buildWavBuffer(userAudioChunks)
            : null;
        // Libère la mémoire dès que le WAV est construit.
        userAudioChunks = [];
        userAudioBytes  = 0;

        let debrief = null;

        // 1) Tentative multimodale (audio user → analyse prononciation enrichie)
        if (audioWav) {
            try {
                debrief = await genererDebrief(geminiKey, historique, userName, userGender, audioWav);
            } catch (e) {
                console.error('❌ [realtime] Débrief multimodal échec :', e.message, '— fallback texte-only.');
            }
        }

        // 2) Fallback texte-only si le multimodal a planté OU si pas d'audio
        if (!debrief) {
            try {
                debrief = await genererDebrief(geminiKey, historique, userName, userGender, null);
            } catch (e) {
                console.error('❌ [realtime] Débrief texte-only échec aussi :', e.message);
            }
        }

        // 3) Envoi du résultat (avec ou sans debrief — le frontend gère l'absence)
        if (debrief) {
            safeSend({ type: 'game_over', debrief, champsRemplis, totalChamps: champsRequis.length });
        } else {
            safeSend({
                type: 'game_over',
                champsRemplis,
                totalChamps: champsRequis.length,
                debriefError: 'Les deux tentatives de débrief ont échoué — voir logs serveur.',
            });
        }
    };

    // -----------------------------------------------------------------
    // Forward d'un chunk audio vers Gemini Live ET Deepgram (parallèle)
    // + accumulation pour le débrief multimodal.
    // -----------------------------------------------------------------
    const forwardAudioToLive = (chunk) => {
        // Vers Gemini Live (génère la réponse audio du client)
        if (liveWS && liveWS.readyState === WebSocket.OPEN) {
            const b64 = Buffer.from(chunk).toString('base64');
            liveWS.send(JSON.stringify({
                realtime_input: {
                    media_chunks: [{ mime_type: 'audio/pcm;rate=16000', data: b64 }],
                },
            }));
        }
        // Vers Deepgram (transcription propre, en parallèle, binaire pur)
        if (dgConnection && dgConnection.readyState === WebSocket.OPEN) {
            dgConnection.send(chunk);
        }
        // Accumule pour le débrief multimodal (cap à MAX_AUDIO_BYTES).
        // Chunk peut être un Buffer Node ou un ArrayBuffer ; on normalise.
        if (!isGameOver && userAudioBytes < MAX_AUDIO_BYTES) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = MAX_AUDIO_BYTES - userAudioBytes;
            if (buf.length <= remaining) {
                userAudioChunks.push(buf);
                userAudioBytes += buf.length;
            } else {
                userAudioChunks.push(buf.subarray(0, remaining));
                userAudioBytes += remaining;
                if (!userAudioTruncated) {
                    userAudioTruncated = true;
                    console.warn(`⚠️ [realtime] Audio user > ${MAX_AUDIO_BYTES} bytes (~10 min) — troncature pour débrief.`);
                }
            }
        }
    };

    // -----------------------------------------------------------------
    // Messages du frontend
    // -----------------------------------------------------------------
    ws.on('message', (msg, isBinary) => {
        // Binary frame = audio PCM 16-bit 16kHz LE depuis l'AudioWorklet
        if (isBinary) {
            if (liveReady) {
                forwardAudioToLive(msg);
            } else {
                // Tamponne quelques chunks le temps que setupComplete arrive
                if (audioBufferBeforeReady.length < 50) {
                    audioBufferBeforeReady.push(msg);
                }
            }
            return;
        }

        // Sinon : message JSON de contrôle
        let data;
        try { data = JSON.parse(msg.toString()); } catch { return; }

        if (data.type === 'config') {
            // {type:'config', variant:'A'|'B', userName, userGender}
            // Persona FIXE (voix + nom + personnalité) + scénario généré à la volée.
            const persona  = PERSONAS_NIV1[data.variant] || PERSONAS_NIV1.A;
            const scenario = genererScenario(persona);

            const titreClient = persona.gender === 'F' ? 'Mevrouw' : 'Meneer';
            currentProfil = {
                // Identité (fixe)
                id:          persona.id,
                voornaam:    persona.voornaam,
                familienaam: persona.familienaam,
                gender:      persona.gender,
                nom:         `${titreClient} ${persona.familienaam}`,
                // Scène (générée — visible côté UI pour planter le décor)
                role:        `${capitalize(scenario.beroep.label_nl)} · ${scenario.ville}`,
                ville:       scenario.ville,
                age:         `${scenario.age} ans`,
                situation:   scenario.situationFam.label_fr,
                beroep:      capitalize(scenario.beroep.label_nl),
                // Détail du dossier (gardé côté serveur — c'est ce que le conseiller doit extraire)
                persona,
                scenario,
                champsIds:   scenario.champsIds,
            };

            userName      = data.userName  || '';
            userGender    = data.userGender || 'M';
            champsRequis  = construireChamps(currentProfil.champsIds);
            champsRemplis = [];
            goodbyePhase  = false;
            isGameOver    = false;
            historique.length = 0;
            currentUserTr = '';
            currentAiTr   = '';
            userAudioChunks = [];
            userAudioBytes  = 0;
            userAudioTruncated = false;

            console.log(`📋 [realtime] Persona ${persona.id} (${currentProfil.nom}) — scénario : ${scenario.age}a, ${scenario.beroep.label_nl}, ${scenario.ville}, "${scenario.krediet.label_nl}" ${scenario.kredietBedrag}€, ${champsRequis.length} champs [${scenario.champsIds.join(', ')}].`);
            safeSend({ type: 'fields_selected', champs: champsRequis, profil: {
                nom: currentProfil.nom, role: currentProfil.role, ville: currentProfil.ville,
                age: currentProfil.age, situation: currentProfil.situation, beroep: currentProfil.beroep,
            }});

            if (!liveWS) openLive();
            if (!dgConnection) setupDeepgram();
            return;
        }

        if (data.type === 'stop') {
            // L'utilisateur a cliqué sur "Arrêter" → on demande le débrief si
            // pas déjà fait, et on ferme proprement quand il est envoyé.
            console.log('🛑 [realtime] Stop demandé par le frontend.');
            if (!isGameOver) {
                isGameOver = true;
                triggerDebrief();
            }
            return;
        }
    });

    ws.on('close', () => {
        console.log('🔌 [realtime] Frontend déconnecté.');
        if (liveWS && liveWS.readyState === WebSocket.OPEN) {
            try { liveWS.close(); } catch {}
        }
        if (dgKeepAliveInterval) { clearInterval(dgKeepAliveInterval); dgKeepAliveInterval = null; }
        if (dgConnection && dgConnection.readyState === WebSocket.OPEN) {
            try { dgConnection.close(); } catch {}
        }
    });

    ws.on('error', (e) => {
        console.error('❌ [realtime] Frontend WS error :', e.message);
    });
}

// =====================================================================
// EXPORT — attachWebSocket(httpServer, geminiKey)
// Monte un WS server sur le path /ws-realtime, sans toucher au WS
// principal de server.js (qui sert le simulateur cascade).
// =====================================================================
function attachWebSocket(httpServer, geminiKey) {
    if (!geminiKey) {
        console.warn('⚠️ [realtime] GEMINI_API_KEY manquante — endpoint /ws-realtime inactif.');
        return;
    }

    const wssRealtime = new WebSocket.Server({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        const { url } = request;
        if (url === '/ws-realtime') {
            wssRealtime.handleUpgrade(request, socket, head, (ws) => {
                wssRealtime.emit('connection', ws, request);
            });
        }
        // Sinon : on laisse le wss principal (server.js) gérer.
    });

    wssRealtime.on('connection', (ws) => {
        handleFrontendConnection(ws, geminiKey);
    });

    console.log(`🚀 [realtime] WS Gemini Live monté sur /ws-realtime (modèle ${LIVE_MODEL}, voix M=${LIVE_VOICE_M} / F=${LIVE_VOICE_F}).`);
}

module.exports = { attachWebSocket };
