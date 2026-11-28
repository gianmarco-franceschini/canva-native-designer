// Limiti della chat condivisi da server e client (senza dipendenze, per il bundle client).

/** Lunghezza massima di un messaggio dell'utente. */
export const MAX_MESSAGE_CHARS = 4000;
/** Messaggi della cronologia inviati al modello. */
export const HISTORY_LIMIT = 20;
/** Header con l'id della conversazione restituito da POST /api/chat. */
export const CONVERSATION_HEADER = "X-Conversation-Id";
