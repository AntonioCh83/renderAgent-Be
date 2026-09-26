// Errore con un messaggio sicuro da mostrare all'utente finale
export class PublicError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}
