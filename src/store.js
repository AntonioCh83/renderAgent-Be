import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const STORAGE_DIR = fileURLToPath(new URL('../storage/', import.meta.url));
export const RENDERS_DIR = path.join(STORAGE_DIR, 'renders');
const DESIGNS_DIR = path.join(STORAGE_DIR, 'designs');

await mkdir(RENDERS_DIR, { recursive: true });
await mkdir(DESIGNS_DIR, { recursive: true });

const UUID = /^[0-9a-f-]{36}$/i;

// Persistenza su file JSON: sufficiente per il prototipo, sostituibile con un DB.
export async function createDesign({ profile, final }) {
  const design = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    profile,
    final,
    versions: [],
    renders: []
  };
  await saveDesign(design);
  return design;
}

export async function getDesign(id) {
  if (!UUID.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(DESIGNS_DIR, `${id}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveDesign(design) {
  await writeFile(path.join(DESIGNS_DIR, `${design.id}.json`), JSON.stringify(design, null, 2));
}
