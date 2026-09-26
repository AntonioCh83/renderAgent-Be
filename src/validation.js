import { EMPTY_PROFILE, FURNITURE_MODES } from './designAgent.js';
import { PublicError } from './errors.js';

const MAX_MESSAGES = 40;
const MAX_USER_CHARS = 1000;
const MAX_ASSISTANT_CHARS = 2000;
const MAX_PROFILE_CHARS = 5000;

export class ValidationError extends PublicError {
  constructor(message) {
    super(message, 400);
  }
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Accetta solo ruoli user/assistant: il client non può iniettare messaggi di sistema.
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) throw new ValidationError('messages deve essere un array.');
  if (messages.length > MAX_MESSAGES) throw new ValidationError('Conversazione troppo lunga, ricomincia un nuovo progetto.');

  const clean = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({
      role: m.role,
      content: str(m.content, m.role === 'user' ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS),
      options: Array.isArray(m.options) ? m.options.slice(0, 8).map(o => str(o, 80)).filter(Boolean) : []
    }))
    .filter(m => m.content);

  if (!clean.some(m => m.role === 'user')) throw new ValidationError('Manca il messaggio dell\'utente.');
  return clean;
}

// Il profilo arriva dal client (conversazione stateless): lo teniamo solo se ha la forma attesa.
export function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return EMPTY_PROFILE;
  if (JSON.stringify(profile).length > MAX_PROFILE_CHARS) return EMPTY_PROFILE;

  const out = {};
  for (const [key, empty] of Object.entries(EMPTY_PROFILE)) {
    const value = profile[key];
    if (Array.isArray(empty)) out[key] = Array.isArray(value) ? value.slice(0, 10) : [];
    else out[key] = str(value, 200);
  }
  if (!FURNITURE_MODES.includes(out.furniture_mode)) out.furniture_mode = '';
  return out;
}

export function sanitizeInstruction(text) {
  const clean = str(text, 500);
  if (!clean) throw new ValidationError('Descrivi la modifica che desideri.');
  return clean;
}
