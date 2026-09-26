import { readFileSync } from 'node:fs';

const CATALOG_PATH = new URL('../data/catalogo.json', import.meta.url);

// Il catalogo vive in data/catalogo.json: in futuro verrà popolato dall'upload CSV/Excel dell'area admin.
function loadCatalog() {
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
}

export function getAvailableProducts() {
  return loadCatalog().filter(p => Number(p.giacenza) > 0);
}

export function getProductsByIds(ids) {
  const catalog = loadCatalog();
  return ids
    .map(id => catalog.find(p => p.id === id))
    .filter(Boolean);
}

// Versione compatta per il prompt: solo i campi utili alla scelta, niente URL o immagini.
export function catalogForPrompt() {
  return getAvailableProducts()
    .map(p => `${p.id} | ${p.categoria} | ${p.nome} | finitura ${p.finitura} | ${p.formato} | ${p.descrizione}`)
    .join('\n');
}
