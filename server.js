import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { BRAND } from './src/config.js';
import { nextTurn, finalizeDesign, refineDesign } from './src/designAgent.js';
import { getProductsByIds } from './src/catalog.js';
import { createDesign, getDesign, saveDesign, RENDERS_DIR } from './src/store.js';
import { generateRenders } from './src/renderer.js';
import { sanitizeMessages, sanitizeProfile, sanitizeInstruction } from './src/validation.js';
import { PublicError } from './src/errors.js';

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map(o => o.trim());
const RENDER_VARIANTS = Math.min(4, Math.max(1, Number(process.env.RENDER_VARIANTS) || 2));
const MAX_RENDERS_PER_DESIGN = Number(process.env.MAX_RENDERS_PER_DESIGN) || 12;

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '100kb' }));
app.use('/renders', express.static(RENDERS_DIR, { maxAge: '7d' }));

// Protegge i crediti OpenAI/Replicate da abusi
const limiter = (limit, message) => rateLimit({
  windowMs: 15 * 60 * 1000,
  limit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: message }
});
const chatLimiter = limiter(80, 'Troppi messaggi in poco tempo, riprova tra qualche minuto.');
const renderLimiter = limiter(10, 'Hai raggiunto il limite di render, riprova tra qualche minuto.');
const refineLimiter = limiter(20, 'Troppe modifiche in poco tempo, riprova tra qualche minuto.');

function toClientDesign(design) {
  const reasons = new Map(design.final.selected_products.map(p => [p.id, p.reason]));
  return {
    id: design.id,
    createdAt: design.createdAt,
    profile: design.profile,
    final: design.final,
    products: getProductsByIds([...reasons.keys()]).map(p => ({ ...p, reason: reasons.get(p.id) })),
    renders: design.renders
  };
}

async function loadDesignOr404(req, res) {
  const design = await getDesign(req.params.id);
  if (!design) res.status(404).json({ error: 'Progetto non trovato.' });
  return design;
}

app.get('/api/config', (req, res) => {
  res.json(BRAND);
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const messages = sanitizeMessages(req.body?.messages);
  const profile = sanitizeProfile(req.body?.profile);

  const turn = await nextTurn(messages, profile);
  if (turn.type !== 'complete') return res.json(turn);

  // Intervista conclusa: seconda chiamata che sceglie i prodotti e scrive il prompt del render
  const transcript = [...messages, { role: 'assistant', content: turn.message }];
  const final = await finalizeDesign(transcript, turn.profile);
  const design = await createDesign({ profile: turn.profile, final });
  res.json({ ...turn, design: toClientDesign(design) });
});

app.get('/api/designs/:id', async (req, res) => {
  const design = await loadDesignOr404(req, res);
  if (design) res.json(toClientDesign(design));
});

app.post('/api/designs/:id/render', renderLimiter, async (req, res) => {
  const design = await loadDesignOr404(req, res);
  if (!design) return;
  if (design.renders.length >= MAX_RENDERS_PER_DESIGN) {
    return res.status(429).json({ error: 'Numero massimo di render raggiunto per questo progetto.' });
  }

  const urls = await generateRenders(design.id, design.final.render_prompt, RENDER_VARIANTS);
  const createdAt = new Date().toISOString();
  const version = design.versions.length;
  design.renders.push(...urls.map(url => ({ url, createdAt, version })));
  await saveDesign(design);

  res.json(toClientDesign(design));
});

app.post('/api/designs/:id/refine', refineLimiter, async (req, res) => {
  const instruction = sanitizeInstruction(req.body?.instruction);
  const design = await loadDesignOr404(req, res);
  if (!design) return;

  const { message, final } = await refineDesign(design.final, instruction);
  design.versions.push({ final: design.final, instruction, replacedAt: new Date().toISOString() });
  design.final = final;
  await saveDesign(design);

  res.json({ message, design: toClientDesign(design) });
});

// Express 5 inoltra qui anche gli errori delle route async
app.use((err, req, res, next) => {
  if (err instanceof PublicError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Richiesta troppo grande.' });
  }
  // Solo lo stack: gli errori degli SDK possono contenere header con le chiavi API
  const errorStatus = err.status || err.response?.status;
  const errorMessage = err.message || "Errore sconosciuto";
  console.error(`Rendering error (${errorStatus || 500}): ${errorMessage}`);
  res.status(500).json({
    error: errorStatus === 402
      ? "L'account Replicate non ha credito disponibile."
      : "Errore nella generazione dell'immagine.",
    details: process.env.NODE_ENV === 'production' ? undefined : errorMessage
  });
});

// In Express 5 gli errori di avvio (es. porta occupata) arrivano alla callback
app.listen(PORT, err => {
  if (err) throw err;
  console.log(`Server attivo su http://localhost:${PORT}`);
});
