import Replicate from 'replicate';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RENDERS_DIR } from './store.js';
import { PublicError } from './errors.js';

const replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });

// flux-schnell è rapido ed economico; per render finali di qualità impostare ad es.
// RENDER_MODEL=black-forest-labs/flux-1.1-pro nel .env
const MODEL = process.env.RENDER_MODEL || 'black-forest-labs/flux-schnell';

const QUALITY_SUFFIX = ' Photorealistic architectural interior photography, high-end design magazine editorial, realistic materials and textures, soft natural shadows, sharp focus, 24mm lens, no people, no text.';

async function toBuffer(output) {
  const item = Array.isArray(output) ? output[0] : output;
  if (!item) throw new Error('Replicate non ha restituito alcuna immagine.');

  // SDK v1: FileOutput espone blob(); versioni/modelli diversi possono restituire una stringa URL
  if (typeof item.blob === 'function') {
    return Buffer.from(await (await item.blob()).arrayBuffer());
  }
  const res = await fetch(String(item));
  if (!res.ok) throw new Error(`Download immagine fallito (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

const REPLICATE_ERRORS = {
  401: 'Token Replicate non valido: controlla REPLICATE_API_TOKEN nel .env del backend.',
  402: "Credito Replicate esaurito: ricarica l'account Replicate per generare i render.",
  429: 'Replicate è sovraccarico o hai superato il limite di richieste, riprova tra poco.'
};

// Gli errori dell'SDK contengono la richiesta completa, header Authorization compreso:
// non vanno mai loggati per intero.
function toPublicError(err) {
  const status = err.response?.status;
  console.error(`Replicate: ${status ?? ''} ${String(err.message).split('\n')[0].slice(0, 300)}`);
  return new PublicError(REPLICATE_ERRORS[status] || 'Generazione del render non riuscita, riprova tra poco.', 502);
}

async function generateOne(prompt, filename) {
  const output = await replicate.run(MODEL, {
    input: {
      prompt,
      aspect_ratio: '3:2',
      output_format: 'jpg',
      output_quality: 90,
      seed: Math.floor(Math.random() * 1_000_000)
    }
  });
  // Gli URL di Replicate scadono: salviamo l'immagine in locale e la serviamo da /renders
  await writeFile(path.join(RENDERS_DIR, filename), await toBuffer(output));
  return `/renders/${filename}`;
}

export async function generateRenders(designId, renderPrompt, count) {
  const prompt = renderPrompt.trim() + QUALITY_SUFFIX;
  const stamp = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, i) => generateOne(prompt, `${designId}-${stamp}-${i}.jpg`))
  );

  const urls = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const failed = results.filter(r => r.status === 'rejected').map(r => toPublicError(r.reason));
  if (urls.length === 0) throw failed[0];
  return urls;
}
