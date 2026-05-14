require('dotenv').config({ path: require('path').resolve(__dirname, '../Simulateur Vocal/.env') });
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const realtimeBranch = require('./server-realtime');   // proto Gemini Live (branche parallèle)

const app = express();
const server = http.createServer(app);
// wss principal en noServer pour pouvoir router les upgrades par path
// (le proto Gemini Live a son propre WS sur /ws-realtime)
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
    if (req.url === '/ws-realtime') return;   // géré par server-realtime.js
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const dgKey    = process.env.DEEPGRAM_API_KEY?.trim();
const geminiKey = process.env.GEMINI_API_KEY?.trim();
const elevenKey = process.env.ELEVENLABS_API_KEY?.trim();

console.log(`=========================================`);
console.log(`🇧🇪 MDS DUTCH SIMULATOR — Crédit Cofidis`);
if (!dgKey)     console.error("❌ DEEPGRAM_API_KEY manquante !");
if (!geminiKey) console.error("❌ GEMINI_API_KEY manquante !");
if (!elevenKey) console.error("❌ ELEVENLABS_API_KEY manquante !");
console.log(`=========================================`);

app.use(express.static('public'));

// ---- BRANCHE PARALLÈLE — Prototype Gemini Live (Vlaams) ----
// Route /realtime sert public/realtime.html, et /ws-realtime monte
// un WS distinct sans toucher au wss principal. Voir architecture.md.
app.get('/realtime', (req, res) => res.sendFile(path.join(__dirname, 'public', 'realtime.html')));
realtimeBranch.attachWebSocket(server, geminiKey);

// ==========================================
// CORRECTION TRANSCRIPTION DEEPGRAM
// ==========================================
function corrigerTranscription(texte) {
    let t = texte;
    // Cofidis (nombreuses variantes mal reconnues en NL)
    t = t.replace(/\b(koffie\s*dis[ei][sz]?|koffie\s*dies|koffi\s*dis|cofides|confidis|kofidies|kofidis|koffinis|cofidies|coffee\s*dis|koffiedis|koffie\s*niece|koffinies)\b/gi, 'Cofidis');
    t = t.replace(/\bkoffie\b(?=\s+belgi)/gi, 'Cofidis');
    // @ pour les adresses e-mail (David peut dire "at" ou "appelstaartje")
    t = t.replace(/\bappelstaartje\b/gi, '@');
    t = t.replace(/\s+at\s+/g, '@');
    // Kredietaanvraag
    t = t.replace(/\bcreditcard(aanvraag)?\b/gi, 'kredietaanvraag');
    // Phrases courantes mal reconnues en NL
    t = t.replace(/\bmaak\s*[ij]e?\s+uw\b/gi, 'mag ik uw');   // "maak je uw" → "mag ik uw"
    t = t.replace(/\bmaak\s*[ij]e?\s+ook\b/gi, 'mag ik ook'); // "maak je ook" → "mag ik ook"
    t = t.replace(/\bmaak\s*[ij]e?\b/gi, 'mag ik');           // "maak je/ik" général → "mag ik"
    t = t.replace(/\bkan\s*[ij]e?\s+uw\b/gi, 'kunt u uw');    // "kan je uw" → "kunt u uw"
    t = t.replace(/\bkunnen\s+u\b/gi, 'kunt u');               // "kunnen u" → "kunt u"
    t = t.replace(/\bhebben\s+u\b/gi, 'heeft u');              // "hebben u" → "heeft u"
    // Rijksregisternummer (mot composé que Deepgram fragmente souvent)
    t = t.replace(/\b(direct|rijks|recht(streeks)?)\s*(register|registreer)\s*(nummer|nummers?)\b/gi, 'rijksregisternummer');
    t = t.replace(/\brigis\s*ter\s*(nummer)?\b/gi, 'rijksregisternummer');
    t = t.replace(/\bregister\s*nummer\b/gi, 'rijksregisternummer');
    // "en dat is je X" → "en wat is uw X" (Deepgram confond wat/dat et uw/je dans les questions)
    t = t.replace(/\b(en\s+)?dat\s+is\s+je\b/gi, (_, prefix) => (prefix || '') + 'wat is uw');
    return t;
}

// ==========================================
// CHAMPS DU DOSSIER CRÉDIT
// ==========================================
const CHAMPS_FIXES = [
    { id: 'naam',  label: 'Naam + voornaam', fr: 'Nom + Prénom' },
    { id: 'adres', label: 'Adres',           fr: 'Adresse complète' },
];

// Lookup de tous les champs disponibles
const ALL_CHAMPS = [
    { id: 'naam',                label: 'Naam + voornaam',              fr: 'Nom + Prénom' },
    { id: 'adres',               label: 'Adres',                        fr: 'Adresse complète' },
    { id: 'geboortedatum',       label: 'Geboortedatum',                fr: 'Date de naissance' },
    { id: 'rijksregisternummer', label: 'Rijksregisternummer',          fr: 'N° de registre national' },
    { id: 'identiteitskaart',    label: 'Kopie identiteitskaart (r/v)', fr: 'Copie carte d\'identité' },
    { id: 'kredietbedrag',       label: 'Kredietbedrag',                fr: 'Montant du crédit demandé' },
    { id: 'kredietdoel',         label: 'Doel van het krediet',         fr: 'But du crédit' },
    { id: 'burgerlijke_staat',   label: 'Burgerlijke staat',            fr: 'État civil' },
    { id: 'kinderen_ten_laste',  label: 'Kinderen ten laste + bijslag', fr: 'Enfants à charge + allocations' },
    { id: 'beroep_type',         label: 'Beroepssituatie',              fr: 'Situation professionnelle (type)' },
    { id: 'maandinkomen',        label: 'Maandelijks inkomen',          fr: 'Revenu mensuel net' },
    { id: 'bewijs_inkomen',      label: 'Bewijsdocument inkomen',       fr: 'Justificatif de revenu à envoyer' },
];

// Construit la liste depuis les IDs fixes du profil (liste plate, pas de groupes)
function construireChamps(champsIds) {
    const result = [];
    for (const id of (champsIds || [])) {
        const champ = ALL_CHAMPS.find(c => c.id === id);
        if (champ) result.push({ ...champ });
    }
    return result;
}

// ==========================================
// APPEL GEMINI AVEC RETRY 503/429
// ==========================================
async function appelGemini(body, maxRetries = 2) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 15000);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.status === 503 || res.status === 429) {
                const err = await res.text();
                console.error(`❌ Gemini HTTP ${res.status} (essai ${attempt}/${maxRetries}) :`, err.slice(0, 200));
                if (attempt < maxRetries) { await new Promise(r => setTimeout(r, 2500 * attempt)); continue; }
                throw new Error(`HTTP ${res.status}`);
            }
            if (!res.ok) {
                const err = await res.text();
                console.error(`❌ Gemini HTTP ${res.status} :`, err.slice(0, 400));
                throw new Error(`HTTP ${res.status}`);
            }
            return await res.json();
        } catch (e) {
            clearTimeout(timeoutId);
            if (attempt < maxRetries && e.name !== 'AbortError') {
                await new Promise(r => setTimeout(r, 2500 * attempt)); continue;
            }
            throw e;
        }
    }
}

// ==========================================
// WEBSOCKET — SESSION PAR CONNEXION
// ==========================================
wss.on('connection', (ws) => {
    console.log('🟢 Nouveau stagiaire connecté.');

    let dgConnection     = null;
    let isConnecting     = false;
    let keepAliveInterval = null;
    let historique       = [];
    let jauge            = 0;
    let currentConfig    = {};
    let isGameOver       = false;
    let isIAThinking     = false;
    let transcriptBuffer = "";
    let dernierEnvoi     = "";
    let champsRequis     = [];
    let champsRemplis    = [];
    let goodbyePhase     = false;

    const safeSend = (payload) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    // ---- DEEPGRAM NL ----
    const setupDeepgram = () => {
        if (!dgKey || isConnecting || (dgConnection && dgConnection.readyState === WebSocket.OPEN)) return;
        isConnecting = true;

        // smart_format désactivé — causait "ja hallo" → "jaro"
        const deepgramUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=nl&interim_results=true&encoding=linear16&sample_rate=16000&endpointing=false&utterance_end_ms=3500&vad_events=true&keepalive=true&numerals=true`;
        dgConnection = new WebSocket(deepgramUrl, { headers: { Authorization: `Token ${dgKey}` } });

        dgConnection.on('open', () => {
            console.log("✅ Deepgram NL prêt.");
            isConnecting = false;
            // Keepalive toutes les 8 secondes pour éviter les déconnexions pendant la lecture audio
            keepAliveInterval = setInterval(() => {
                if (dgConnection?.readyState === WebSocket.OPEN) {
                    dgConnection.send(JSON.stringify({ type: "KeepAlive" }));
                }
            }, 8000);
        });

        dgConnection.on('message', async (data) => {
            try {
                const response = JSON.parse(data);
                const transcript = response.channel?.alternatives?.[0]?.transcript;
                if (transcript && !isGameOver) {
                    safeSend({ type: 'interim_text', value: transcript, isFinal: response.is_final });
                    if (response.is_final) transcriptBuffer += " " + transcript;
                }
                if (response.type === "UtteranceEnd" && !isGameOver && !isIAThinking) {
                    const raw          = transcriptBuffer.trim();
                    const fullSentence = corrigerTranscription(raw);
                    if (fullSentence.length > 3 && fullSentence !== dernierEnvoi) {
                        dernierEnvoi = fullSentence;
                        console.log(`🗣️ ${currentConfig.userName || 'Conseiller'} (NL) : "${fullSentence}"`);
                        safeSend({ type: 'text', value: fullSentence });
                        transcriptBuffer = "";
                        await evaluerQuestion(fullSentence);
                    } else {
                        transcriptBuffer = "";
                    }
                }
            } catch (e) { console.error("❌ Erreur Deepgram:", e.message); }
        });

        dgConnection.on('close', () => {
            isConnecting = false;
            dgConnection = null;
            if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
            console.log("⚠️ Deepgram déconnecté.");
        });
    };

    // ---- ÉVALUATION DE LA QUESTION ----
    const evaluerQuestion = async (questionDavid) => {
        if (!geminiKey) return;
        isIAThinking = true;
        safeSend({ type: 'ia_thinking' });
        const nomConseiller   = currentConfig.userName || 'le conseiller';
        const titreConseiller = currentConfig.userGender === 'F' ? 'mevrouw' : 'meneer';
        historique.push(`${nomConseiller}: "${questionDavid}"`);

        const champsActifs   = champsRequis;
        const champsRestants = champsActifs.filter(c => !champsRemplis.includes(c.id));
        const idsDisponibles = champsActifs.map(c => c.id).join(', ');
        const beroepInstructie        = currentConfig.situationProInstructie   || '';
        const comportementInstructie  = currentConfig.comportementInstructie  || '';
        const humeurInstructie        = currentConfig.humeurInstructie        || '';

        const goodbyeInstructie = goodbyePhase ? `

⭐⭐ DOSSIER COMPLET — PRISE DE CONGÉ ⭐⭐
Toutes les informations ont été collectées avec succès. David te dit au revoir.
Réponds UNIQUEMENT avec une phrase d'au revoir chaleureuse et courte en néerlandais.
Exemples : "Dank u wel voor uw medewerking. Nog een prettige dag. Tot ziens!" ou "Uitstekend, alles is in orde. Bedankt en tot ziens!"
NE demande plus aucune information. NE mentionne plus aucun champ. Juste un au revoir naturel.
` : '';

        const systemPrompt = `
Tu joues le rôle de ${currentConfig.nom}, ${currentConfig.role}.
Tu as introduit une demande de crédit chez Cofidis Belgique. Un(e) conseiller(ère) Cofidis (${nomConseiller}) te rappelle car il manque des informations à ton dossier.

⭐ RÈGLE FONDAMENTALE : Tu es un CLIENT COOPÉRATIF. C'est dans ton propre intérêt de compléter ce dossier pour obtenir ton crédit. Tu réponds TOUJOURS à toutes les questions posées, sans jamais refuser ni esquiver. Même si une question porte sur ton revenu, ton adresse, ta situation familiale ou tout autre sujet personnel — tu y réponds obligatoirement. Ne dis jamais "dat gaat u niet aan", "dat wil ik niet zeggen", ou toute autre formule de refus.

⚠️ RÈGLE ABSOLUE — TU ES LE CLIENT, PAS LE CONSEILLER :
Tu ne poses JAMAIS de questions sur le dossier, les documents à fournir, le montant du crédit, les conditions, les procédures Cofidis ou quoi que ce soit lié au crédit. Tu réponds UNIQUEMENT à ce que le conseiller te demande. Si tu es tenté(e) de poser une question sur le dossier ou le crédit, remplace-la par une courte réaction neutre ("Oké.", "Ik begrijp het.", "Goed.") et attends la prochaine question.

⚠️ RÈGLE DE RÉPONSE STRICTE :
Tu ne donnes JAMAIS d'information de façon spontanée ou proactive. Chaque information doit être explicitement demandée par le conseiller. Ne donne QUE ce qui est demandé, rien de plus. N'anticipe pas les questions suivantes. Si le conseiller n'a pas encore demandé ton adresse, ne la donne pas. Si le conseiller n'a pas encore demandé ta date de naissance, ne la donne pas. Attends d'être interrogé(e).

PROFIL : ${currentConfig.prompt}
SITUATION PRO : ${beroepInstructie}
COMPORTEMENT : ${comportementInstructie}
HUMEUR ET PERSONNALITÉ : ${humeurInstructie}

CHAMPS DÉJÀ COLLECTÉS : ${champsRemplis.length > 0 ? champsRemplis.join(', ') : 'aucun'}
CHAMPS ENCORE NÉCESSAIRES : ${champsRestants.map(c => `${c.id} (${c.fr})`).join(', ') || 'dossier complet !'}

RÈGLE DE RÉPÉTITION :
Si le conseiller dit "kunt u herhalen", "kunt u dat herhalen", "sorry?", "pardon?", "wat zei u?", "kunt u dat herhalen alstublieft" ou toute variante exprimant qu'il n'a pas compris : répète l'information que tu viens de donner, légèrement reformulée et plus lentement si ton niveau le permet. Ne marque aucun nouveau champ_rempli dans ce cas (variation = 0).

RÈGLE DE VÉRIFICATION (champs complexes) :
Après avoir fourni les informations pour 'geboortedatum', 'rijksregisternummer', 'adres' ou 'maandinkomen', ajoute SYSTÉMATIQUEMENT une courte phrase demandant au conseiller de confirmer :
- Pour geboortedatum : "...Heeft u dat genoteerd?" ou "...Klopt dat zo?"
- Pour rijksregisternummer : "...Heeft u dat opgeschreven?" ou "...Kunt u het even herhalen?"
- Pour adres : "...Heeft u het adres?" ou "...Is dat duidelijk?"
- Pour maandinkomen : "...Heeft u dat?" ou "...Klopt dat bedrag?"
Si le conseiller répète correctement (ou dit "ja", "correct", "klopt", "ik heb het"), confirme brièvement ("Perfect." / "Ja, dat klopt.") — ne marque pas de nouveau champ. Si le conseiller répète incorrectement, corrige gentiment.

RÈGLES STRICTES :
0. Tu es le CLIENT. ${nomConseiller} est le/la conseiller(ère) Cofidis qui t'appelle. Tu l'appelles UNIQUEMENT "u" ou "${titreConseiller}" — jamais par son nom de famille. Tu ne connais pas le nom de famille du/de la conseiller(ère) et tu ne le devines JAMAIS. N'utilise surtout pas TON propre nom de famille pour appeler le/la conseiller(ère) (ex: si tu t'appelles Janssen, ne dis JAMAIS "meneer Janssen" ou "mevrouw Janssen" en parlant au/à la conseiller(ère)).
   Si ${nomConseiller} confirme ton identité en début d'appel ("Spreek ik met meneer/mevrouw [ton nom]?") et que tu confirmes : marque 'naam' comme champ_rempli. Pas besoin du prénom.
   ⚠️ UNE FOIS QUE TU T'ES IDENTIFIÉ(E), ne répète plus jamais de phrase d'identification ("aan de lijn", "dit is mevrouw X", etc.). Réponds directement à la question posée, comme dans une vraie conversation téléphonique.
1. Ne répète JAMAIS spontanément une information déjà dans "CHAMPS DÉJÀ COLLECTÉS".
2. Ne confonds PAS les champs : si David demande la carte d'identité, ne redonne PAS ton rijksregisternummer.
3. Si David mentionne un document de façon vague ("j'ai besoin de documents", "ik heb documenten nodig") SANS préciser lequel : pose DIRECTEMENT la question "Welk document heeft u precies nodig?" ou "Over welk document gaat het?" — sans JAMAIS reformuler ni répéter ce que David vient de dire. Ne commence pas ta réponse par une paraphrase de la phrase de David.
4. Si David nomme explicitement un document précis (loonstrook, bankafschrift, identiteitskaart, aanslagbiljet...) : accepte de l'envoyer avec une courte confirmation ("Dat is geen probleem." / "Dat stuur ik u op.").
   ⚠️ NE demande PAS encore l'adresse e-mail si d'autres champs documents ("bewijs_inkomen" ou "identiteitskaart") sont encore dans "CHAMPS ENCORE NÉCESSAIRES". Attends que David ait mentionné TOUS les documents avant de demander l'email.
   ✅ Demande l'adresse e-mail SEULEMENT quand c'est le dernier champ document restant (ou quand David a mentionné tous les documents en une seule phrase).
5. Si David donne une adresse e-mail (tu verras "@" dans sa phrase) : confirme que tu vas envoyer TOUS les documents à cette adresse, puis marque comme champ_rempli le premier champ document encore dans "CHAMPS ENCORE NÉCESSAIRES".
   ⚠️ RÈGLE CRITIQUE : "bewijs_inkomen" et "identiteitskaart" ne peuvent être marqués champ_rempli QUE si le message de David contient "@" OU si "@" apparaît déjà dans l'historique de la conversation. Si l'email est déjà dans l'historique, marque directement le champ comme champ_rempli sans redemander l'adresse.
   Si deux champs documents sont encore à compléter quand l'email est donné, marque le premier — le second sera marqué à l'échange suivant (l'email est déjà connu).
5b. Pour "rijksregisternummer" : invente un numéro fictif réaliste (format XX.XX.XX-XXX.XX), énoncer chiffre par chiffre en néerlandais. Ex: "nul zeven punt nul twee punt achttien, koppelteken, twee vijf drie punt vier zeven".
5c. Pour les dates ET tous les montants en euros : écris TOUJOURS les nombres en toutes lettres en néerlandais. Ex: "drie april negentienhonderd zeven en vijftig" pour 03/04/1957, "tweeduizend driehonderd vijftig euro" pour 2350€, "honderd twintig euro" pour 120€. Jamais de chiffres dans "reponse".
6. Pour beroep_type : donne le type de situation professionnelle (bediende, arbeider, gepensioneerd, werkloze, arbeidsongeschikt, zelfstandige). Réponds directement avec ton type de situation.
7. Pour maandinkomen : donne le montant exact de ton revenu mensuel net. Écris TOUJOURS le montant EN TOUTES LETTRES en néerlandais — jamais en chiffres. Ex : "tweeduizend driehonderd vijftig euro" pour 2350€, "duizend negenhonderd euro" pour 1900€. Varie le montant d'un appel à l'autre. ${beroepInstructie}
8. Pour bewijs_inkomen : indique quel document tu peux envoyer (loonstrook, bankafschrift, aanslagbiljet...) et demande l'adresse e-mail si elle n'est pas encore dans l'historique.
9. Pour "kinderen_ten_laste" : ce champ nécessite DEUX informations — (1) le nombre d'enfants à charge ET (2) le montant mensuel de la kinderbijslag. Ne marque "kinderen_ten_laste" comme champ_rempli que lorsque David a obtenu ces deux informations. Si David demande le montant de la kinderbijslag et que tu as déjà donné le nombre d'enfants, donne le montant directement — ne répète PAS le nombre d'enfants.
9b. Varie toujours les détails (montants, dates précises) d'un appel à l'autre.
10. Ta réponse ("reponse") est TOUJOURS en néerlandais, même si ${nomConseiller} parle en français.
11. "correction" est en FRANÇAIS pour aider ${nomConseiller}, null si son néerlandais est correct.
12. Ne juge pas la prononciation de mots propres/français comme "Cofidis" — c'est hors sujet.
${goodbyeInstructie}

ÉVALUATION :
- Bonne question NL + info obtenue → variation = +1 ou +2
- Petite erreur NL mais intention claire → variation = 0 + correction
- Grosse erreur / phrase en français → variation = -1 + correction

"champ_rempli" = EXACTEMENT l'un de : ${idsDisponibles} — ou null.

RÉPONDS EN JSON :
{
    "reponse": "réponse en néerlandais",
    "variation": entier -2 à +2,
    "champ_rempli": "identifiant ou null",
    "correction": "correction en français ou null",
    "raison": "explication courte en français"
}`;

        try {
            const data = await appelGemini({
                contents: [{ parts: [{ text: `Historique :\n${historique.slice(-20).join('\n')}\n\n→ JSON ?` }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { responseMimeType: "application/json", temperature: 0.55 },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ]
            });

            if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]) {
                console.error("❌ Gemini vide :", JSON.stringify(data).slice(0, 400));
                throw new Error("Réponse Gemini vide.");
            }

            let rawText = data.candidates[0].content.parts[0].text;
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) rawText = jsonMatch[0];
            const result = JSON.parse(rawText);

            jauge = Math.max(0, Math.min(10, jauge + result.variation));

            if (result.champ_rempli
                && champsActifs.some(c => c.id === result.champ_rempli)
                && !champsRemplis.includes(result.champ_rempli)) {
                champsRemplis.push(result.champ_rempli);
                console.log(`✅ ${result.champ_rempli} (${champsRemplis.length}/${champsActifs.length})`);
            }

            historique.push(`Client: "${result.reponse}"`);

            safeSend({
                type:        'ai_response',
                value:       result.reponse,
                variation:   result.variation,
                newScore:    jauge,
                correction:  result.correction,
                champRempli: result.champ_rempli,
                reason:      result.raison,
                champsRemplis,
                totalChamps: champsActifs.length
            });

            await genererVoix(result.reponse);

            if (goodbyePhase) {
                // Le client vient de dire au revoir → débrief après l'audio
                isGameOver = true;
                setTimeout(() => declencherDebrief(), 3000);
            } else if (champsRemplis.length >= champsActifs.length) {
                // Tous les champs collectés → passer en phase d'au revoir
                goodbyePhase = true;
                safeSend({ type: 'goodbye_phase' });
            }

        } catch (e) {
            console.error("❌ Erreur IA :", e.message);
            const secours = "Sorry, kunt u dat herhalen?";
            safeSend({ type: 'ai_response', value: secours, variation: 0, newScore: jauge, correction: null, champsRemplis, totalChamps: champsRequis.length });
            await genererVoix(secours);
        } finally {
            isIAThinking = false;
        }
    };

    // ---- DÉBRIEF PÉDAGOGIQUE ----
    const declencherDebrief = async () => {
        const nomConseiller = currentConfig.userName || 'le conseiller';
        const pronom        = currentConfig.userGender === 'F' ? 'elle' : 'il';
        const promptDebrief = `Tu es un coach bienveillant spécialisé en néerlandais professionnel belge.
LANGUE DE RÉPONSE : FRANÇAIS UNIQUEMENT.
Tutoie ${nomConseiller}. Analyse UNIQUEMENT les lignes commençant par "${nomConseiller}:" dans le transcript.
NE commente PAS les mots propres français (Cofidis, noms belges) ni la prononciation de ceux-ci.
Sois encourageant(e) ET précis(e) — donne des exemples concrets tirés du transcript.
Si le transcript est très court (moins de 3 échanges), adapte ton analyse à ce qui est disponible.

RÉPONDS UNIQUEMENT EN JSON valide, toutes les valeurs en français :
{
  "encouragement": "Message chaleureux de 2 phrases sur l'effort et le courage de pratiquer",
  "points_forts": [
    "point fort 1 avec exemple concret tiré du transcript",
    "point fort 2 avec exemple concret"
  ],
  "grammaire": [
    { "erreur": "phrase exacte mal formulée", "correction": "forme correcte", "explication": "règle en 1 phrase" },
    { "erreur": "...", "correction": "...", "explication": "..." }
  ],
  "conjugaison": [
    { "erreur": "forme utilisée", "correction": "forme correcte", "explication": "règle courte" }
  ],
  "vocabulaire": [
    { "mot_nl": "mot ou expression NL utile", "traduction": "traduction FR", "exemple": "exemple d'usage dans ce contexte crédit" },
    { "mot_nl": "...", "traduction": "...", "exemple": "..." },
    { "mot_nl": "...", "traduction": "...", "exemple": "..." }
  ],
  "prononciation": "Feedback sur l'accent et la prononciation basé sur la transcription Deepgram (difficultés typiques du NL : g, ij, eu, ui, r...). Si pas d'info suffisante, donne des conseils généraux pour ce niveau.",
  "phrase_modele": "Une question exemplaire en NL parfaitement formulée pour ce contexte crédit"
}
Règles : grammaire et conjugaison doivent avoir 1 à 3 entrées chacune (utilise [] vide si aucune erreur trouvée). vocabulaire doit avoir exactement 3 entrées.

Transcript :
${historique.join('\n')}`;

        try {
            const data = await appelGemini({
                contents: [{ parts: [{ text: promptDebrief }] }],
                generationConfig: { responseMimeType: "application/json" }
            });
            if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]) throw new Error("Debrief vide");
            let rawText = data.candidates[0].content.parts[0].text;
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (jsonMatch) rawText = jsonMatch[0];
            const debrief = JSON.parse(rawText);
            safeSend({ type: 'game_over', debrief, champsRemplis, totalChamps: champsRequis.length });
        } catch (e) {
            console.error("❌ Erreur Debrief:", e.message);
            safeSend({ type: 'game_over', champsRemplis, totalChamps: champsRequis.length });
        }
    };

    // ---- DÉCROCHÉ INITIAL DU CLIENT ----
    const genererDecroché = () => {
        const niveau = currentConfig.niveau || 1;
        const nom    = currentConfig.nom || '';
        const h      = new Date().getHours();
        const moment = h < 12 ? 'goedemorgen' : h < 18 ? 'goedemiddag' : 'goedenavond';

        let options;
        if (niveau <= 2) {
            options = [
                `Ja, hallo? U spreekt met ${nom}, ${moment}.`,
                `Hallo? Ja, met ${nom}. ${moment.charAt(0).toUpperCase() + moment.slice(1)}, spreekt u?`,
            ];
        } else if (niveau <= 5) {
            options = [
                `Ja, hallo? Met ${nom}.`,
                `Ja, ${moment}.`,
                `Hallo, ja?`,
            ];
        } else if (niveau <= 8) {
            options = [
                `Ja, hallo?`,
                `Ja?`,
                `Hallo.`,
            ];
        } else {
            options = [`Ja?`, `Ja.`, `Hallo.`];
        }
        return options[Math.floor(Math.random() * options.length)];
    };

    // ---- ELEVENLABS TTS ----
    const genererVoix = async (texte) => {
        if (!elevenKey || !currentConfig.voiceId) return;
        try {
            const url = `https://api.elevenlabs.io/v1/text-to-speech/${currentConfig.voiceId}?output_format=mp3_22050_32&optimize_streaming_latency=4`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: texte,
                    model_id: "eleven_turbo_v2_5",
                    voice_settings: currentConfig.voiceSettings || { stability: 0.50, similarity_boost: 0.80, use_speaker_boost: true }
                })
            });
            const buffer = await response.arrayBuffer();
            safeSend({ type: 'audio', value: Buffer.from(buffer).toString('base64') });
        } catch (e) { console.error("❌ Erreur ElevenLabs:", e.message); }
    };

    // ---- MESSAGES DU FRONTEND ----
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.type === 'config') {
                currentConfig    = data;
                jauge            = 0;
                champsRequis     = construireChamps(currentConfig.champsIds);
                champsRemplis    = [];
                isGameOver       = false;
                goodbyePhase     = false;
                isIAThinking     = false;
                transcriptBuffer = "";
                dernierEnvoi     = "";
                historique       = [];
                safeSend({ type: 'fields_selected', champs: champsRequis });
                setupDeepgram();
                console.log(`📋 Champs session (${champsRequis.length}) : ${champsRequis.map(c => c.id).join(', ')}`);

                // Le client "décroche" et parle en premier
                setTimeout(async () => {
                    const salutation = genererDecroché();
                    historique.push(`${currentConfig.nom}: "${salutation}"`);
                    safeSend({ type: 'client_greeting', value: salutation });
                    await genererVoix(salutation);
                }, 800);
            }
        } catch (e) {
            if (dgConnection?.readyState === WebSocket.OPEN && !isGameOver) {
                dgConnection.send(msg);
            } else if (!isConnecting && (!dgConnection || dgConnection.readyState === WebSocket.CLOSED)) {
                setupDeepgram();
            }
        }
    });

    ws.on('close', () => {
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        if (dgConnection) dgConnection.close();
    });
});

const PORT = process.env.NL_PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Serveur MDS Dutch — Prêt sur le port ${PORT}`));
