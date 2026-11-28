# Workflow n8n dell'Agenda aziendale

Questa cartella contiene i tre workflow n8n che collegano l'app a Google Calendar.
Sono file JSON da importare. Non contengono credenziali né segreti.

| File | Webhook (POST) | Cosa fa |
| --- | --- | --- |
| `agenda-freebusy.json` | `/webhook/agenda-freebusy` | Legge solo gli intervalli libero/occupato dei colleghi |
| `agenda-create-event.json` | `/webhook/agenda-create-event` | Crea l'evento sul calendario condiviso e invita i partecipanti |
| `agenda-cancel-event.json` | `/webhook/agenda-cancel-event` | Annulla un evento creato dall'app |
| `verify-signature.js` | — | Funzione di verifica della firma, copiata nel Code node "Verifica firma" |

I percorsi corrispondono a quelli di `src/lib/n8n/client.ts`.

## Struttura comune

Ogni workflow segue lo stesso schema:

1. **Webhook**: metodo POST, opzione *Raw Body* attiva, risposta tramite nodo "Respond to Webhook".
2. **Verifica firma** (Code): controlla `X-Timestamp` e `X-Signature` sul body grezzo con il segreto
   `$vars.AGENDA_WEBHOOK_SECRET`. Se la firma non è valida, il nodo **Rispondi 401** risponde
   `401 {"error":"unauthorized"}`.
3. **Valida input** (Code): applica gli stessi limiti dell'app (al massimo 15 email, intervallo di al
   massimo 14 giorni, titolo da 1 a 200 caratteri, durata massima di 8 ore). Se i dati non sono
   validi, risponde `400 {"error":"invalid_input"}`.
4. Le richieste HTTP verso Google Calendar usano la credenziale **"Google Calendar agenda@"**.
5. **Rispondi**: risponde in JSON con lo stato e il corpo preparati dal Code node precedente.

Se Google restituisce un errore o non risponde, il workflow risponde
`502 {"error":"calendar_error"}`. Nessuna risposta contiene titoli o descrizioni di eventi.

### Contratto

- **freebusy**: richiesta `{emails, timeMin, timeMax}`. Risposta
  `{calendars: {[email]: {busy: [{start, end}]}}}`. Un calendario che non si può leggere ha
  `{error: "<motivo>"}` al posto di `busy`. L'app lo considera occupato per tutto l'intervallo.
- **create-event**: richiesta
  `{requestId, title, description, start, end, organizerEmail, attendeeEmails, allowConflict}`.
  1. Il workflow cerca sul calendario condiviso un evento con
     `privateExtendedProperty=agendaRequestId=<requestId>`. Se lo trova, lo restituisce: chiamare
     due volte con lo stesso `requestId` crea un solo evento.
  2. Altrimenti legge il freebusy di organizzatore e partecipanti. Un calendario illeggibile conta
     come occupato. Se c'è un conflitto e `allowConflict` è `false`, risponde
     `{status: "conflict", busy: {[email]: [{start, end}]}}`.
  3. Altrimenti crea l'evento sul calendario `AGENDA_SHARED_CALENDAR_ID` con
     `sendUpdates=all`, invitando l'organizzatore e i partecipanti (senza duplicati). Salva
     `extendedProperties.private.agendaRequestId` e usa come descrizione
     `"<descrizione>\n\nCreato da <organizerEmail> tramite Agenda aziendale"`. Risponde
     `{status: "created", eventId, htmlLink}`.
- **cancel-event**: richiesta `{requestId, googleEventId}`.
  1. Il workflow legge l'evento. Se l'evento appartiene a un'altra richiesta (`agendaRequestId`
     diverso), risponde `403 {"error":"forbidden"}`.
  2. Altrimenti lo elimina con `sendUpdates=all` e risponde `{status: "cancelled"}`.
  3. Se l'evento è già stato eliminato (404/410 o stato `cancelled`), risponde comunque
     `{status: "cancelled"}`: la chiamata si può ripetere senza effetti.

## Prerequisiti

1. **Account Google `agenda@`** (Workspace aziendale):
   - deve avere il permesso *Apportare modifiche agli eventi* sul calendario aziendale condiviso;
   - deve poter vedere il libero/occupato dei colleghi. Nel dominio è l'impostazione predefinita di
     Google Workspace.
2. **Credenziale n8n** di tipo *Google Calendar OAuth2 API*, con nome esatto
   **`Google Calendar agenda@`** e collegata all'account `agenda@`.
3. **Variabili n8n** (*Overview → Variables*). Richiedono un piano n8n che include le Variables.
   - `AGENDA_WEBHOOK_SECRET`: stesso valore di `N8N_WEBHOOK_SECRET` dell'app. Usate una stringa
     casuale lunga, per esempio `openssl rand -hex 32`.
   - `AGENDA_SHARED_CALENDAR_ID`: ID del calendario aziendale condiviso (per esempio
     `xxxx@group.calendar.google.com`).
4. **Modulo `crypto` nei Code node**: su n8n Cloud è già disponibile. Su un'istanza self-hosted,
   impostate `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (o aggiungete `crypto` all'elenco esistente).

## Importazione

1. In n8n aprite **Workflows → Import from File** e importate i tre file `agenda-*.json`, uno per
   volta.
2. In ogni nodo HTTP Request (nodi "Google FreeBusy", "Cerca evento esistente", "FreeBusy
   partecipanti", "Crea evento", "Leggi evento", "Elimina evento"), verificate che sia selezionata la
   credenziale `Google Calendar agenda@`. Se n8n non la collega da sola, selezionatela a mano.
3. I workflow vengono importati **disattivati**. Attivateli solo dopo i test qui sotto.
4. Nell'app, impostate `N8N_BASE_URL` all'URL base dell'istanza (per esempio
   `https://<istanza>.app.n8n.cloud`) e `N8N_WEBHOOK_SECRET` allo stesso valore di
   `AGENDA_WEBHOOK_SECRET`.

## Verifica della firma (`verify-signature.js`)

`verify-signature.js` usa lo stesso algoritmo di `verifyRequest` in `src/lib/n8n/sign.ts`:

- `X-Signature = hex(HMAC-SHA256(secret, X-Timestamp + "." + rawBody))`;
- la richiesta viene rifiutata se il timestamp si discosta di più di 5 minuti, nel passato o nel
  futuro;
- le firme vengono confrontate a tempo costante.

Il Code node "Verifica firma" di ciascun workflow contiene, **identica**, la funzione compresa tra i
marcatori `// BEGIN verifyAgendaSignature` e `// END verifyAgendaSignature`. Sotto la funzione c'è
il codice che legge gli header e il body grezzo. Se modificate la funzione, ricopiatela uguale nei
tre Code node. Il test `src/lib/n8n/workflows.test.ts` fallisce se i testi non coincidono.

Se esportate di nuovo un workflow da n8n per aggiornare questi file:

- lasciate `"active": false`;
- in `credentials` lasciate solo `{"googleCalendarOAuth2Api": {"name": "Google Calendar agenda@"}}`,
  eliminando l'`id`.

## Test

### Test automatici (senza n8n)

```bash
cd agenda-app
npx vitest run src/lib/n8n
```

- `verify-signature.test.ts` controlla che `verify-signature.js` dia lo stesso esito di
  `signRequest`/`verifyRequest` con firme valide, alterate, scadute e future.
- `workflows.test.ts` controlla i file JSON:
  - percorsi dei webhook uguali a quelli di `client.ts`;
  - "Verifica firma" come primo nodo dopo il webhook;
  - credenziali presenti solo come nome;
  - ogni ramo che termina con una risposta.

  Esegue anche in locale il codice dei Code node, per esempio per controllare che non escano titoli,
  che gli eventi non vengano duplicati e che la cancellazione sia idempotente.

### Test manuali su n8n (prima di attivare)

Usate l'URL di test del webhook (`/webhook-test/...`, dopo aver premuto *Listen for test event*)
oppure, dopo l'attivazione, quello di produzione (`/webhook/...`). Per firmare una richiesta:

```bash
export SECRET='<valore di AGENDA_WEBHOOK_SECRET>'
export URL='https://<istanza>/webhook-test/agenda-freebusy'
BODY='{"emails":["mario.rossi@azienda.it","anna.bianchi@azienda.it"],"timeMin":"2026-12-01T08:00:00.000Z","timeMax":"2026-12-02T18:00:00.000Z"}'
TS=$(node -e 'console.log(Date.now())')
SIG=$(node -e 'const c=require("crypto");console.log(c.createHmac("sha256",process.env.SECRET).update(process.argv[1]+"."+process.argv[2]).digest("hex"))' "$TS" "$BODY")
curl -sS -X POST "$URL" -H 'Content-Type: application/json' \
  -H "X-Timestamp: $TS" -H "X-Signature: $SIG" --data-raw "$BODY"
```

Il body inviato deve essere identico, byte per byte, a quello firmato.

1. **Richiesta non firmata**: lo stesso `curl` senza gli header `X-Timestamp`/`X-Signature` deve
   rispondere `401 {"error":"unauthorized"}`.
2. **freebusy firmato con 2 email di prova**: la risposta contiene solo `calendars` con intervalli
   `busy` (`start`/`end`) e nessun `summary`.
3. **create-event**: inviate due volte lo stesso body con lo stesso `requestId`, per esempio
   `{"requestId":"test-0001","title":"Prova Agenda","description":"Test","start":"…","end":"…","organizerEmail":"…","attendeeEmails":["…"],"allowConflict":true}`.
   Entrambe le risposte devono restituire lo stesso `eventId` e sul calendario condiviso deve
   esserci un solo evento.
4. **cancel-event**:
   - Prima, con un `requestId` diverso (`{"requestId":"test-9999","googleEventId":"<eventId>"}`):
     la risposta è `403 {"error":"forbidden"}` e l'evento resta.
   - Poi `{"requestId":"test-0001","googleEventId":"<eventId>"}`: la risposta è
     `{"status":"cancelled"}` e l'evento sparisce.
   - Ripetendo la chiamata, la risposta è ancora `{"status":"cancelled"}`.
