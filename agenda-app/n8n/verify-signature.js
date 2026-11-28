/* eslint-disable @typescript-eslint/no-require-imports */
// Verifica della firma HMAC delle richieste dell'app Agenda verso n8n.
//
// Stesso algoritmo di verifyRequest in agenda-app/src/lib/n8n/sign.ts:
//   X-Signature = hex(HMAC-SHA256(secret, timestamp + "." + rawBody))
//   rifiuto se |now - timestamp| > 5 minuti (in entrambe le direzioni),
//   confronto a tempo costante, firma malformata => false (non lancia mai).
//
// La funzione tra i marcatori BEGIN/END è copiata IDENTICA nel Code node
// "Verifica firma" dei tre workflow (agenda-*.json); un test
// (src/lib/n8n/workflows.test.ts) controlla che coincida.

// BEGIN verifyAgendaSignature
function verifyAgendaSignature(rawBody, secret, timestampMs, signature, nowMs) {
  const crypto = require('crypto');
  const MAX_SKEW_MS = 5 * 60 * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_SKEW_MS) return false;
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(timestampMs + '.' + rawBody).digest('hex'),
    'hex',
  );
  const given = Buffer.from(signature, 'hex');
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}
// END verifyAgendaSignature

module.exports = { verifyAgendaSignature };
