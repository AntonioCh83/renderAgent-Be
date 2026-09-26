import OpenAI from 'openai';
import { catalogForPrompt, getAvailableProducts } from './catalog.js';
import { BRAND } from './config.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export const PHASES = ['ambiente', 'emozioni', 'stile', 'materiali', 'colore', 'dettagli', 'arredo', 'completato'];
const INPUT_TYPES = ['open', 'choice', 'multi_choice', 'visual_choice', 'palette'];

// Scelta del "bivio" sull'arredo: '' finché l'utente non ha risposto
export const FURNITURE_MODES = ['', 'su_misura', 'sorprendimi', 'solo_superfici'];
const FURNITURE_CATEGORIES = new Set(['mobili', 'complementi']);

// ---------- JSON Schema (structured outputs, strict) ----------

const colorList = { type: 'array', items: { type: 'string', description: 'Colore HEX, es. #A1B2C3' } };
const namedColor = {
  type: 'object',
  additionalProperties: false,
  required: ['hex', 'name'],
  properties: { hex: { type: 'string' }, name: { type: 'string' } }
};

const optionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'emoji', 'hint', 'colors'],
  properties: {
    label: { type: 'string' },
    emoji: { type: 'string' },
    hint: { type: 'string' },
    colors: colorList
  }
};

const profileSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['archetype', 'room_type', 'mood', 'keywords', 'palette', 'materials', 'finishes', 'furniture_mode', 'furniture_traits', 'lighting', 'constraints', 'budget'],
  properties: {
    archetype: { type: 'string' },
    room_type: { type: 'string' },
    mood: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' } },
    palette: { type: 'array', items: namedColor },
    materials: { type: 'array', items: { type: 'string' } },
    finishes: { type: 'array', items: { type: 'string' } },
    furniture_mode: { type: 'string', enum: FURNITURE_MODES },
    furniture_traits: { type: 'array', items: { type: 'string' } },
    lighting: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    budget: { type: 'string' }
  }
};

const finalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'room_type', 'archetype', 'summary', 'furniture_mode', 'palette', 'sections', 'selected_products', 'inspiration_pieces', 'render_prompt'],
  properties: {
    title: { type: 'string' },
    room_type: { type: 'string' },
    archetype: { type: 'string' },
    summary: { type: 'string' },
    furniture_mode: { type: 'string', enum: FURNITURE_MODES.filter(Boolean) },
    palette: { type: 'array', items: namedColor },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['area', 'choice'],
        properties: { area: { type: 'string' }, choice: { type: 'string' } }
      }
    },
    selected_products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string' } }
      }
    },
    // Arredi non presenti a catalogo, generati per completare la scena
    inspiration_pieces: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'emoji', 'render_en'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          emoji: { type: 'string' },
          render_en: { type: 'string', description: 'Descrizione in inglese per il render: forma, materiale, colore, posizione' }
        }
      }
    },
    render_prompt: { type: 'string' }
  }
};

const turnSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'message', 'phase', 'progress', 'input_type', 'options', 'allow_free_text', 'profile'],
  properties: {
    type: { type: 'string', enum: ['question', 'complete'] },
    message: { type: 'string' },
    phase: { type: 'string', enum: PHASES },
    progress: { type: 'number' },
    input_type: { type: 'string', enum: INPUT_TYPES },
    options: { type: 'array', items: optionSchema },
    allow_free_text: { type: 'boolean' },
    profile: profileSchema
  }
};

const refineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'final'],
  properties: { message: { type: 'string' }, final: finalSchema }
};

export const EMPTY_PROFILE = {
  archetype: '', room_type: '', mood: '', keywords: [], palette: [],
  materials: [], finishes: [], furniture_mode: '', furniture_traits: [],
  lighting: '', constraints: [], budget: ''
};

// ---------- Prompt ----------

const FINAL_RULES = `
- title: nome del progetto (es. "Bagno Mediterraneo Materico").
- summary: 2-3 frasi in seconda persona che raccontano l'identikit di gusto del cliente.
- palette: 4-6 colori HEX con nome evocativo, realistici per interni (toni naturali e sofisticati, niente colori puri o "da web").
- furniture_mode: la scelta del cliente sull'arredo (profilo). Se non l'ha espressa usa "sorprendimi".
- sections: una voce per area (Pavimento, Pareti e rivestimenti, Arredo, Illuminazione, Complementi) con la scelta descritta in dettaglio: materiale, finitura, colore, formato, forme.
- selected_products: SOLO id presenti nel CATALOGO, coerenti con le scelte, con una motivazione breve e personale (reason, max 20 parole). Cerca di coprire ogni area pertinente alla stanza. Se nessun prodotto è adatto a un'area descrivila in sections ma NON inventare id.
- inspiration_pieces: arredi e complementi NON presenti a catalogo che servono a completare la scena (name breve, description di max 20 parole con forma, materiale e colore, emoji, render_en = la stessa descrizione in inglese per il render con forma, materiale, colore e posizione nella stanza, max 25 parole). Non duplicare i prodotti già scelti dal catalogo.
- ARREDO secondo furniture_mode:
  • "su_misura": ogni mobile deve riflettere i furniture_traits del cliente (forme, sedute, gambe o sospensione, pezzo protagonista, quantità di oggetti). Usa i mobili del catalogo SOLO se non contraddicono i tratti (es. con "seduta composta" niente divano profondo e modulare); altrimenti descrivi pezzi su misura in inspiration_pieces (3-5 pezzi).
  • "sorprendimi": scegli tu arredi coerenti con archetipo, palette e materiali; catalogo quando possibile, il resto in inspiration_pieces (3-5 pezzi).
  • "solo_superfici": niente mobili dal catalogo (solo pavimenti, rivestimenti, sanitari o illuminazione se indispensabili), inspiration_pieces vuoto o al massimo 1-2 elementi minimi di allestimento; la stanza appare quasi vuota per valorizzare le superfici.
- render_prompt: IN INGLESE, 110-180 parole, per un render fotorealistico. Includi: tipo di stanza, stile, materiali precisi di pavimento e pareti (colore, finitura, formato), palette, luce (naturale o artificiale, ora del giorno), inquadratura (es. "wide-angle eye-level shot"). Per l'arredo descrivi OGNI pezzo (catalogo e inspiration_pieces) con forma, materiale, colore e posizione nella stanza; con "solo_superfici" specifica "sparsely furnished, focus on floor and wall surfaces". Niente persone, niente testo o scritte.`;

function chatSystemPrompt(profile) {
  return `Sei ${BRAND.assistantName}, interior designer virtuale di ${BRAND.companyName}. Conduci un'intervista breve, piacevole e un po' poetica per costruire l'IDENTIKIT DI GUSTO del cliente e progettare la sua stanza con i prodotti del nostro magazzino.

STILE DI CONVERSAZIONE
- Una sola domanda per turno. Massimo 2 frasi: un breve commento empatico alla risposta precedente + la domanda. Tono caldo e curioso, mai tecnico.
- Alterna domande evocative (luoghi, sensazioni, ricordi, viaggi, profumi) a domande dirette sui materiali (lucido o opaco, caldo o freddo, fughe o superficie continua).
- In totale 9-13 domande (le più alte solo se il cliente sceglie l'arredo su misura). Non ripetere domande. Se una risposta copre più fasi, vai avanti.

FASI (in ordine)
1. ambiente: quale stanza (già chiesto nel messaggio di benvenuto), dimensioni indicative, luce naturale.
2. emozioni: 2 domande evocative. Esempi: "Che luogo naturale ti rigenera?", "Com'è la tua domenica perfetta?".
3. stile: 1 domanda di scelta tra atmosfere o archetipi.
4. materiali: 2 domande dirette (pavimento lucido o opaco; legno, pietra, cemento o ceramica; fughe visibili o superficie continua).
5. colore: proponi 3-4 palette costruite sulle risposte precedenti.
6. dettagli: OBBLIGATORIA, 1-2 domande: chi vive la stanza (bambini, animali), budget indicativo, un elemento irrinunciabile.
7. arredo: SEMPRE l'ultima fase, vedi sezione ARREDO.

ARREDO
a) Domanda BIVIO, sempre, come "visual_choice" con ESATTAMENTE queste 3 opzioni (label identiche):
   - "Su misura" (emoji 🛋️, hint "Arrediamola insieme su di te")
   - "Sorprendimi" (emoji ✨, hint "Scelgo io, fedele al tuo stile")
   - "Solo superfici" (emoji 🧱, hint "Pavimenti e rivestimenti protagonisti")
   Formula la domanda in modo fantasioso, es. "La tua stanza è pronta ad accoglierti: la arrediamo insieme su misura per te, o preferisci lasciarti sorprendere?".
   Dopo la risposta imposta profile.furniture_mode: "Su misura" → "su_misura", "Sorprendimi" → "sorprendimi", "Solo superfici" → "solo_superfici" (per risposte libere scegli il valore più vicino).
b) Solo se "su_misura": 2-3 domande INDIRETTE e fantasiose (choice o visual_choice) che rivelano come deve essere l'arredo. Esempi:
   - "La sera: sprofondi in una nuvola o ti siedi composto con un buon libro?" → seduta profonda e modulare / poltrona strutturata
   - "Linee morbide come un sasso di fiume o nette come un'architettura?" → forme curve / squadrate
   - "I tuoi oggetti: collezionista di ricordi o tutto l'essenziale?" → tanti complementi / pochi
   - "Un pezzo protagonista che ruba la scena, o tutto in armonia?" → pezzo iconico / insieme omogeneo
   - "Mobili sospesi e leggeri o ben piantati a terra?" → sospesi / con gambe o basamento
   MASSIMO 3 domande in questa fase, poi concludi.
   Adatta le domande alla stanza (es. per un bagno: mobile lavabo, vasca o doccia; per una cucina: isola, penisola, sgabelli).
   Traduci ogni risposta in un tratto concreto in profile.furniture_traits (es. "sedute profonde e modulari", "forme curve", "pezzo protagonista: poltrona scultorea").
c) Con "sorprendimi" o "solo_superfici" non fare altre domande: concludi.

TRADUZIONE EMOZIONI → DESIGN (usala per riempire il profilo, adattandola liberamente)
- bosco, montagna → rovere o noce, pietra, verdi salvia e muschio, luce calda, lana
- mare, scogliera → sabbia e bianco calce, finiture opache, lino, juta, azzurri polverosi
- campagna mediterranea, deserto → cotto, terracotta, intonaci materici, ocra, legno chiaro
- città, loft → cemento, resina, metallo nero, grandi lastre, contrasti netti
- lago, nebbia, nord → grigi morbidi, rovere chiaro, bouclé, luce diffusa
- giardino tropicale → verdi profondi, zellige, rattan, piante, ottone

TIPI DI INPUT (input_type)
- "visual_choice": domande evocative o di atmosfera. 3-4 opzioni, ciascuna con emoji e 2-3 colori HEX che ne evocano l'atmosfera.
- "choice": domande dirette a risposta singola, 2-4 opzioni brevi (es. "Lucido", "Opaco", "Satinato").
- "multi_choice": quando ha senso sceglierne più d'una (es. materiali preferiti).
- "palette": fase colore; ogni opzione ha 4-5 colori HEX e un nome evocativo come label.
- "open": domanda libera, options vuoto.
Per ogni opzione: label breve (max 4 parole), emoji pertinente, hint = sottotitolo di max 6 parole (o stringa vuota), colors = 1-3 HEX pertinenti (per palette 4-5).
allow_free_text: true, salvo casi eccezionali.

COLORI
Ogni HEX deve sembrare un materiale o una finitura reale d'interni: toni naturali e leggermente desaturati (intonaci, legni, pietre, tessuti, ceramiche smaltate). Evita colori puri o "da web" (#FF0000, #B22222, #483D8B, #0000FF...). Anche le palette audaci vanno declinate in versione sofisticata (es. terracotta #B8653E, verde bottiglia #2F4A3A, blu petrolio #2C4F5E).

PROFILO (profile)
Restituisci SEMPRE il profilo completo e aggiornato partendo dal PROFILO ATTUALE e aggiungendo ciò che hai capito. archetype = nome evocativo dello stile in 2-3 parole, mai una sola parola generica (es. "Nordic Coastal", "Mediterraneo Materico", "Loft Botanico"); proponilo appena emerge un'atmosfera (di solito dopo le domande sulle emozioni) e affinalo man mano. palette max 6 colori, keywords max 8.
progress: da 0 a 1, quanto dell'intervista è completato.

CONCLUSIONE
Finché non hai finito: type = "question".
Quando hai completato TUTTE le fasi (dettagli e arredo compresi): type = "complete", phase = "completato", progress = 1, input_type = "open", options = [], allow_free_text = false, message = una frase entusiasta di chiusura (il progetto verrà preparato subito dopo).

PROFILO ATTUALE:
${JSON.stringify(profile)}`;
}

function finalizeSystemPrompt(profile) {
  return `Sei ${BRAND.assistantName}, interior designer di ${BRAND.companyName}. Hai appena concluso l'intervista con il cliente (trascritta di seguito). Ora progetta la sua stanza scegliendo i prodotti dal nostro magazzino.

Regole:${FINAL_RULES}

CATALOGO DISPONIBILE IN MAGAZZINO (id | categoria | nome | finitura | formato | descrizione):
${catalogForPrompt()}

PROFILO EMERSO DALL'INTERVISTA:
${JSON.stringify(profile)}`;
}

function refineSystemPrompt(final) {
  return `Sei ${BRAND.assistantName}, interior designer di ${BRAND.companyName}. Il cliente ha già un progetto e chiede una modifica.
Applica SOLO la modifica richiesta mantenendo coerente tutto il resto; aggiorna di conseguenza sections, palette, selected_products e render_prompt.
Se la richiesta non riguarda il progetto d'arredo, lascia il progetto invariato e spiegalo gentilmente in message.
message: una frase breve che conferma cosa hai cambiato.

Regole per final:${FINAL_RULES}

CATALOGO DISPONIBILE IN MAGAZZINO (id | categoria | nome | finitura | formato | descrizione):
${catalogForPrompt()}

PROGETTO ATTUALE:
${JSON.stringify(final)}`;
}

// ---------- Normalizzazione output ----------

const HEX = /^#[0-9a-f]{6}$/i;
const cleanColors = (colors, max) => (colors || []).filter(c => HEX.test(c)).slice(0, max);
const cleanNamed = (palette, max) => (palette || []).filter(c => HEX.test(c.hex)).slice(0, max);

// Il modello tende a dimenticare nel prompt i pezzi d'ispirazione: li accodiamo sempre noi
function buildRenderPrompt(base, pieces, surfacesOnly) {
  let prompt = base.trim();
  const extras = pieces.map(p => p.render_en.trim().replace(/\.$/, '')).filter(Boolean);
  if (extras.length) prompt += ` The room also includes: ${extras.join('; ')}.`;
  if (surfacesOnly && !/sparsely furnished/i.test(prompt)) {
    prompt += ' Sparsely furnished, almost empty room: focus on floor and wall surfaces.';
  }
  return prompt.slice(0, 2200);
}

function normalizeFinal(final) {
  const surfacesOnly = final.furniture_mode === 'solo_superfici';
  const pieces = final.inspiration_pieces.slice(0, surfacesOnly ? 2 : 6);
  // Con "solo superfici" niente mobili o complementi dal catalogo
  const availableIds = new Set(getAvailableProducts()
    .filter(p => !surfacesOnly || !FURNITURE_CATEGORIES.has(p.categoria))
    .map(p => p.id));
  const seen = new Set();
  return {
    ...final,
    palette: cleanNamed(final.palette, 6),
    // Scarta ID inventati o prodotti senza giacenza
    selected_products: final.selected_products.filter(p => {
      if (!availableIds.has(p.id) || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    }),
    inspiration_pieces: pieces,
    render_prompt: buildRenderPrompt(final.render_prompt, pieces, surfacesOnly)
  };
}

function normalizeTurn(turn) {
  return {
    ...turn,
    progress: Math.min(1, Math.max(0, Number(turn.progress) || 0)),
    options: turn.options.slice(0, 6).map(o => ({ ...o, colors: cleanColors(o.colors, 5) })),
    profile: {
      ...turn.profile,
      palette: cleanNamed(turn.profile.palette, 6),
      keywords: turn.profile.keywords.slice(0, 8)
    }
  };
}

// ---------- Chiamate OpenAI ----------

const MAX_ATTEMPTS = 3;

// I modelli "mini" ogni tanto sbagliano formato: output troncato (spazi all'infinito),
// testo messo nel campo refusal, JSON non valido. In questi casi ritentiamo con temperatura più bassa.
async function structuredCompletion(messages, schemaName, schema, temperature) {
  let lastProblem;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: attempt === 1 ? temperature : Math.min(temperature, 0.4),
      // Un turno completo sta ampiamente sotto questo limite: evita output fuori controllo
      max_completion_tokens: 3000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: true, schema }
      }
    });

    const { message, finish_reason: finishReason } = response.choices[0];
    if (message.refusal) {
      lastProblem = `refusal: ${message.refusal.slice(0, 200)}`;
    } else if (finishReason === 'length') {
      lastProblem = `troncato: ${JSON.stringify(message.content?.trimEnd().slice(-200))}`;
    } else {
      try {
        return JSON.parse(message.content);
      } catch {
        lastProblem = `JSON non valido: ${message.content?.slice(0, 200)}`;
      }
    }
    console.warn(`[${schemaName}] tentativo ${attempt}/${MAX_ATTEMPTS} scartato (${lastProblem})`);
  }
  throw new Error('Il modello non ha restituito una risposta valida.');
}

function toOpenAIMessage(m) {
  if (m.role === 'assistant' && m.options?.length) {
    return { role: 'assistant', content: `${m.content}\n[Opzioni proposte: ${m.options.join(' | ')}]` };
  }
  return { role: m.role, content: m.content };
}

export async function nextTurn(messages, profile) {
  const request = [{ role: 'system', content: chatSystemPrompt(profile) }, ...messages.map(toOpenAIMessage)];
  let turn = await structuredCompletion(request, 'design_turn', turnSchema, 0.7);
  // Capita che il modello lasci vuoto il testo della domanda: un secondo tentativo lo risolve
  if (!turn.message.trim()) {
    console.warn('[design_turn] messaggio vuoto, nuovo tentativo');
    turn = await structuredCompletion(request, 'design_turn', turnSchema, 0.4);
  }
  if (!turn.message.trim()) turn.message = turn.type === 'complete' ? 'Ho tutto quello che mi serve!' : 'Dimmi di più…';
  return normalizeTurn(turn);
}

// Seconda chiamata dedicata: tenere il progetto finale fuori dallo schema del turno evita
// che gpt-4o-mini degeneri in spazi vuoti sul campo nullable.
export async function finalizeDesign(messages, profile) {
  const transcript = messages
    .map(m => `${m.role === 'user' ? 'CLIENTE' : 'DESIGNER'}: ${m.content}`)
    .join('\n');
  const final = await structuredCompletion(
    [
      { role: 'system', content: finalizeSystemPrompt(profile) },
      { role: 'user', content: `Trascrizione dell'intervista:\n${transcript}` }
    ],
    'design_final',
    finalSchema,
    0.6
  );
  return normalizeFinal(final);
}

export async function refineDesign(final, instruction) {
  const result = await structuredCompletion(
    [
      { role: 'system', content: refineSystemPrompt(final) },
      { role: 'user', content: instruction }
    ],
    'design_refine',
    refineSchema,
    0.5
  );
  return { message: result.message, final: normalizeFinal(result.final) };
}
