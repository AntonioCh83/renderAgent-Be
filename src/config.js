// Dati del brand che espone l'app: letti da .env, esposti al FE tramite GET /api/config.
export const BRAND = {
  companyName: process.env.COMPANY_NAME || 'Casa Futuro',
  assistantName: process.env.ASSISTANT_NAME || 'Lia',
  contactEmail: process.env.CONTACT_EMAIL || 'preventivi@example.com'
};
