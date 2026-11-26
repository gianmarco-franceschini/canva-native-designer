# Agenda aziendale con assistente AI — Design (Fase 1)

Data: 2026-11-26
Stato: bozza da approvare

## 1. Intento e perché

In azienda (circa 10 persone, Google Workspace) vengono fissate **riunioni che si sovrappongono**.
Serve una web app interna dove ognuno organizza le proprie riunioni con l'aiuto di un assistente AI
che, **prima** di creare un impegno, controlla i calendari di tutti i partecipanti, segnala i conflitti e propone orari liberi. L'evento viene creato solo dopo
conferma esplicita della persona.

La sicurezza è il requisito principale indicato dall'utente.

## 2. Obiettivi, non-obiettivi, anti-obiettivi

**Obiettivi (Fase 1)**
- Login solo con account Google del dominio aziendale.
- Chat con assistente AI in italiano che:
  - risponde a domande sulla disponibilità ("quando sono liberi Marco e Giulia giovedì?");
  - rileva conflitti per una riunione proposta;
  - propone 2–3 slot liberi per tutti i partecipanti;
  - prepara una proposta di evento che l'utente conferma con un pulsante.
- Modulo "Nuova riunione" alternativo alla chat, con lo stesso controllo conflitti.
- Pagina "Le mie richieste" (in attesa / confermate / annullate).
- Area amministratore: gestione utenti ammessi e ruoli, registro attività (audit log).
- Integrazione con Google Calendar **esclusivamente tramite n8n**.

**Non-obiettivi (Fase 1)**
- Assistente sulle procedure aziendali (base di conoscenza): è la **Fase 2**, i documenti non esistono ancora.
  L'architettura deve permettere di aggiungerla senza rifare nulla, ma non si costruisce ora.
- Prenotazione sale/risorse.
- Invitati esterni al dominio.
- Modifica o cancellazione di eventi creati fuori dall'app; modifica (spostamento) di eventi creati dall'app — si annulla e se ne crea uno nuovo.
- App mobile nativa (la web app deve però essere usabile da telefono).

**Anti-obiettivi (sarebbe un fallimento anche se "funziona")**
- L'assistente crea o modifica un evento senza conferma esplicita dell'utente.
- Un utente vede **titoli o dettagli** degli impegni dei colleghi: si espone solo libero/occupato.
- Qualcuno fuori dal dominio aziendale accede all'app o ai dati.
- Un utente crea eventi a nome di un altro, o legge conversazioni altrui.
- Credenziali Google, chiavi n8n o chiavi AI raggiungibili dal browser.

## 3. Vincoli (decisi dall'utente)

- Calendario: **Google Calendar** (Google Workspace).
- Ponte verso il calendario: **n8n**.
- Backend: **Supabase**.
- Hosting: **Vercel**.
- Privacy: dei colleghi si vede **solo libero/occupato**.
- Utenti: ~10, tutti organizzano le proprie riunioni; un ruolo **amministratore**.
- Il **calendario aziendale condiviso** è il posto dove si raccolgono tutte le riunioni create dall'app, per averle sott'occhio.
  **Non** blocca nessuno: i conflitti si cercano **solo sui calendari dei partecipanti** (incluso il richiedente).
- Riunione con conflitto: si può confermare solo con un'azione esplicita "Conferma comunque" e avviso ben visibile *(proposta, da confermare)*.
- Chi ha creato una riunione può annullarla dall'app *(proposta, da confermare)*.
- Orario lavorativo predefinito: lun–ven 9:00–13:00 e 14:00–18:00, festività italiane escluse, modificabile dall'admin *(proposta, da confermare)*.

## 4. Approcci considerati

| | Approccio | Pro | Contro |
|---|---|---|---|
| **A (scelto)** | Assistente nell'app (Vercel), n8n solo come ponte con webhook stretti verso Google | Identità utente sempre nota, conferma = pulsante reale non affidata all'AI, audit completo in Supabase, più veloce, pronto per la Fase 2 | Più codice nell'app |
| B | Assistente dentro n8n (AI Agent), l'app è solo una chat | Meno codice, comportamento modificabile in n8n | Difficile garantire conferma e identità, credenziale Google ampia in mano all'agente, log divisi |
| C | App → Google API direttamente | Meno pezzi | Scartato: l'utente ha scelto n8n come ponte |

**Scelto A** dall'utente, perché la sicurezza è prioritaria.

## 5. Architettura

```
Browser (Next.js UI)
   │  sessione Supabase (cookie httpOnly)
   ▼
Vercel — Next.js App Router (server)
   ├─ /api/chat          → Claude via Vercel AI SDK, con tool limitati
   ├─ /api/availability  → per il modulo
   ├─ /api/requests/:id/confirm | cancel
   ├─ Supabase (DB + Auth, RLS su tutte le tabelle)
   └─ n8n webhooks (solo lato server, firmati HMAC)
            ├─ WF1 "freebusy"     → Google Calendar FreeBusy API
            └─ WF2 "create-event" → ricontrolla freebusy, poi crea evento
                                      ▼
                               Google Calendar
```

### 5.1 Stack (scelte del progettista)
- Next.js (App Router) + TypeScript, Tailwind + shadcn/ui, interfaccia in italiano.
- Vercel AI SDK con provider Anthropic; modello Claude Sonnet (latenza/costo adeguati a uso interno).
- Supabase: Auth (provider Google), Postgres con RLS, `@supabase/ssr` per le sessioni.
- Validazione input con zod su ogni route e su ogni argomento dei tool AI.
- Fuso orario fisso `Europe/Rome`.

### 5.2 Autenticazione e accesso
- Login "Accedi con Google" tramite Supabase Auth.
- Restrizione dominio **a più livelli**:
  1. parametro `hd=<dominio>` nella richiesta OAuth (solo UX, non è sicurezza);
  2. lato server, dopo il callback: email deve terminare con `@<dominio>` **e** essere presente nella tabella `allowed_users`; altrimenti logout immediato e messaggio di accesso negato;
  3. a livello DB: trigger/hook su creazione utente che rifiuta email fuori dominio.
- Ruoli: `user` e `admin` (in `profiles.role`). Il primo admin viene impostato via seed SQL.
- Middleware Next.js: tutte le pagine tranne `/login` e `/auth/callback` richiedono sessione valida.

### 5.3 Modello dati (Supabase)
- `allowed_users(email pk, full_name, role, active, created_at, created_by)` — gestita dall'admin; è **la rubrica** dei colleghi selezionabili come partecipanti, anche se non hanno mai fatto login *(scelta del progettista)*.
- `profiles(id → auth.users, email, full_name, role, created_at)` — creato al primo login, collegato ad `allowed_users` tramite email.
- `conversations(id, user_id, title, created_at)`
- `messages(id, conversation_id, role, content jsonb, created_at)`
- `event_requests(id, user_id, title, description, start_at, end_at, attendee_ids uuid[], status ['pending','confirmed','cancelled','failed'], conflict_snapshot jsonb, google_event_id, google_event_link, created_at, confirmed_at, error)`
- `audit_log(id, actor_id, action, target_type, target_id, details jsonb, created_at)` — solo inserimento, mai modificabile.

**RLS**
- `conversations`, `messages`, `event_requests`: l'utente legge/scrive solo le proprie righe.
- `profiles`: ognuno legge il proprio; admin legge tutti.
- `allowed_users`: lettura di nome/email dei colleghi attivi per tutti gli autenticati (tramite vista); scrittura solo admin.
- `audit_log`: insert solo da server (service role); select solo admin; nessun update/delete.
- La `service_role` key è usata solo lato server e solo dove serve (audit, chiamate per conto dell'utente già verificato).

### 5.4 Integrazione n8n

Due workflow, ciascuno con Webhook trigger, **verifica firma** come primo passo, risposta JSON.

**Firma delle richieste**: header `X-Signature = HMAC-SHA256(secret, timestamp + "." + body)` e `X-Timestamp`.
n8n rifiuta se la firma non corrisponde o se il timestamp è più vecchio di 5 minuti. Il segreto è
condiviso solo tra variabili d'ambiente Vercel e credenziali n8n. Gli URL dei webhook non sono mai esposti al browser.

**WF1 — freebusy**
- Input: `{ emails: string[], timeMin: ISO, timeMax: ISO }`.
- Azione: Google Calendar FreeBusy query **solo sui calendari dei partecipanti** (il calendario condiviso non è incluso).
- Gli eventi creati dall'app arrivano ai partecipanti come inviti, quindi compaiono nel loro libero/occupato: il costruttore deve verificare con un test reale che gli inviti non ancora accettati risultino occupati.
- Output: `{ calendars: { [email]: { busy: [{start,end}], error?: string } } }` — **solo intervalli occupati**, nessun titolo/dettaglio.
- Limite: massimo 14 giorni di intervallo, massimo 15 email.
- **Errori per singolo calendario** (calendario non visibile, account inesistente): l'app li tratta **come occupato**, mai come libero, e lo segnala all'utente ("non riesco a vedere il calendario di X") *(scelta del progettista)*.

**WF2 — create-event**
- Input: `{ requestId, title, description, start, end, organizerEmail, attendeeEmails[] }`.
- Input aggiuntivo: `allowConflict: boolean` (true solo se l'utente ha premuto "Conferma comunque").
- Azione: ricontrolla freebusy sui calendari dei partecipanti; se c'è un conflitto e `allowConflict` è false risponde `{ status: "conflict", busy }` senza creare nulla; altrimenti crea l'evento sul **calendario aziendale condiviso** con richiedente e partecipanti come invitati, inviando gli inviti.
- Output: `{ status: "created", eventId, htmlLink }`.
- Idempotenza: `requestId` salvato nelle proprietà private dell'evento; se già esiste un evento con quel `requestId`, restituisce quello invece di crearne un altro.

**WF3 — cancel-event**
- Input: `{ requestId, googleEventId }`. Il server Next.js verifica prima che la richiesta appartenga all'utente e sia `confirmed`.
- Azione: elimina l'evento dal calendario condiviso e invia la notifica di annullamento ai partecipanti.
- Output: `{ status: "cancelled" }`. Stessa firma HMAC degli altri workflow.

**Credenziale Google in n8n** (scelta del progettista): un account dedicato del dominio (es. `agenda@<dominio>`)
con permesso di scrittura sul calendario condiviso. La visibilità libero/occupato dei colleghi è quella standard
all'interno di un dominio Workspace. Gli eventi risultano quindi creati dall'account dedicato; nella descrizione
viene indicato "Creato da <nome> tramite Agenda aziendale".

### 5.5 Assistente AI

**Tool disponibili al modello (e nessun altro):**
1. `list_colleagues()` — restituisce nomi ed email attivi dalla tabella `allowed_users` (per risolvere "Marco" → email).
2. `check_availability({ attendees, from, to })` — chiama WF1, restituisce intervalli occupati per persona.
3. `find_free_slots({ attendees, durationMinutes, from, to })` — chiama WF1 e calcola gli slot **nel codice dell'app**
   (non lo fa il modello), entro l'orario lavorativo, restituisce i migliori 3.
4. `propose_event({ title, description?, start, end, attendees })` — **non crea nulla su Google**: verifica conflitti,
   salva una riga `event_requests` in stato `pending` e restituisce i dati per una **scheda di conferma** nella chat.

**Regole**
- La creazione reale avviene solo tramite `POST /api/requests/:id/confirm`, chiamato dal pulsante "Conferma"
  della scheda (o "Conferma comunque" se la scheda mostra un conflitto, che invia `allowConflict: true`).
- `POST /api/requests/:id/cancel`: su `pending` cambia solo lo stato; su `confirmed` chiama WF3. Il server verifica che la richiesta appartenga all'utente, sia `pending`, e la passa a WF2.
- Il richiedente è sempre l'utente autenticato: il modello non può scegliere l'organizzatore.
- I partecipanti devono essere colleghi attivi in `allowed_users` (no indirizzi esterni in Fase 1).
- Il system prompt: italiano, data/ora corrente e fuso, orario lavorativo, divieto di inventare disponibilità,
  obbligo di usare i tool, nessun accesso a dettagli degli eventi.
- Limiti: massimo ~8 chiamate a tool per messaggio; rate limit per utente su `/api/chat` (es. 30 messaggi/10 min).
- Ogni chiamata a tool e ogni conferma/annullamento scrive in `audit_log`.

### 5.6 Interfaccia (scelte del progettista)
- `/login` — pulsante "Accedi con Google".
- `/` — chat con l'assistente; le proposte compaiono come scheda con: titolo, data/ora, partecipanti, esito controllo
  conflitti, pulsanti **Conferma** / **Annulla**; se c'è un conflitto, avviso rosso e **Conferma comunque** al posto di Conferma.
- `/nuova` — modulo: titolo, partecipanti (selezione dalla rubrica), durata, giorno → mostra slot liberi → conferma.
- `/richieste` — elenco richieste dell'utente con stato, link all'evento Google e pulsante **Annulla riunione**.
- `/admin` (solo admin) — utenti ammessi (aggiungi/disattiva, ruolo), orario lavorativo e chiusure, registro attività filtrabile.

```
┌──────────────────────────────────────────────┐
│ Agenda  [Chat] [Nuova] [Richieste] [Admin]   │
├──────────────────────────────────────────────┤
│ Tu: riunione budget con Giulia e Marco       │
│     giovedì, un'ora                          │
│ AI: Giovedì 10–11 Giulia è occupata.         │
│     Liberi per tutti:                        │
│  ┌────────────────────────────────────────┐  │
│  │ Riunione budget                        │  │
│  │ Gio 28/11  14:00–15:00                 │  │
│  │ Giulia, Marco, Tu   ✓ nessun conflitto │  │
│  │ [Conferma]  [Annulla]  [Altri orari]   │  │
│  └────────────────────────────────────────┘  │
├──────────────────────────────────────────────┤
│ Scrivi un messaggio…                   [▶]   │
└──────────────────────────────────────────────┘
```

### 5.7 Sicurezza — riepilogo
- Segreti (Anthropic, n8n HMAC, URL webhook, Supabase service role) solo in variabili d'ambiente Vercel lato server.
- RLS attiva su ogni tabella, verificata con Supabase advisors.
- Header di sicurezza (CSP, HSTS, X-Frame-Options DENY, Referrer-Policy) via `next.config`.
- Validazione zod di input HTTP e argomenti tool; date limitate a finestre ragionevoli.
- Dati inviati al modello AI: solo nomi/email dei colleghi e intervalli occupati, mai titoli di eventi altrui.
- Audit log immutabile di accessi negati, chiamate tool, conferme, errori n8n.
- Dipendenze con versioni bloccate (lockfile).

### 5.8 Predisposizione Fase 2 (non da costruire ora)
Il sistema di tool dell'assistente è modulare: la Fase 2 aggiungerà una tabella documenti con pgvector,
upload riservato all'admin e un tool `search_documents`, senza toccare la parte calendario.

## 6. Prerequisiti Google Workspace (da verificare prima dello sviluppo)
- L'account dedicato `agenda@<dominio>` esiste e ha permesso di scrittura sul calendario condiviso (e di eliminare gli eventi che ha creato).
- La condivisione libero/occupato all'interno del dominio è attiva per tutti i 10 utenti (impostazione admin Workspace).
- Primo task del piano: un test reale di WF1 su tutti i 10 indirizzi.

## 7. Lasciato al costruttore
- Struttura delle cartelle, nomi dei componenti, libreria per il rate limit.
- Algoritmo di calcolo degli slot (rispettando orario lavorativo, festività e conflitti).
- Testi esatti dell'interfaccia e del system prompt.
- Test: unità per calcolo slot, firma HMAC e verifica dominio; test RLS; e2e del flusso proposta → conferma con n8n simulato.

## 8. Dove vive il codice
Cartella `agenda-app/` nel repository corrente, branch `claude/internal-scheduling-webapp-rghx23`.
Consigliato spostarla in un repository dedicato prima del deploy su Vercel.
