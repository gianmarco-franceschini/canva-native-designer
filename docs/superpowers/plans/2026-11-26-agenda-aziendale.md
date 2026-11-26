# Agenda aziendale (Fase 1) — Piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app interna su Next.js che evita riunioni sovrapposte: un assistente AI controlla il libero/occupato dei partecipanti via n8n, propone slot e crea l'evento su Google Calendar solo dopo conferma esplicita.

**Architecture:** Next.js (App Router) su Vercel contiene UI, assistente (Vercel AI SDK + Claude) e API. Supabase fornisce Auth Google (solo dominio aziendale) e Postgres con RLS. n8n espone tre webhook firmati HMAC (freebusy, create-event, cancel-event) ed è l'unico componente che parla con Google Calendar. La logica (slot, conflitti, richieste) è in moduli puri con dipendenze iniettate, testati con Vitest.

**Tech Stack:** Next.js 15, React 19, TypeScript strict, Tailwind CSS 4, `ai` v5 + `@ai-sdk/anthropic`, `@supabase/ssr` + `@supabase/supabase-js`, zod, `date-fns` + `@date-fns/tz`, Vitest, Supabase CLI (migrazioni + pgTAP), n8n (via MCP n8n).

**Spec:** `docs/superpowers/specs/2026-11-26-agenda-aziendale-design.md`
**Design UI:** https://claude.ai/artifact/PXJXvugvK8orNoBJRdN7Sx (5 schermate: Login, Main=chat, Nuova, Richieste, Admin)

## Global Constraints

- Codice in `agenda-app/` nel repo corrente; branch `claude/internal-scheduling-webapp-rghx23`.
- Interfaccia interamente in italiano; `<html lang="it">`.
- Fuso orario fisso `Europe/Rome` per ogni calcolo e visualizzazione.
- Dei colleghi si espone **solo libero/occupato**: nessun titolo/dettaglio di eventi altrui arriva al client né al modello.
- Nessun evento creato su Google senza `POST /api/requests/:id/confirm` dall'utente proprietario.
- Il calendario aziendale condiviso **non** entra nel controllo conflitti; gli eventi vi vengono creati con richiedente e partecipanti come invitati.
- Partecipanti ammessi: solo email attive in `allowed_users`; niente esterni.
- Errore di lettura di un calendario = **occupato** per tutto l'intervallo richiesto, mai libero.
- Orario lavorativo predefinito: lun–ven 09:00–13:00 e 14:00–18:00; festività italiane e chiusure aziendali escluse; modificabile da admin.
- FreeBusy: intervallo max 14 giorni, max 15 email.
- Firma n8n: `X-Timestamp` (ms epoch) e `X-Signature = hex(HMAC-SHA256(secret, timestamp + "." + rawBody))`; rifiuto se timestamp più vecchio di 5 minuti.
- Modello AI: `claude-sonnet-5-5`; max 8 step di tool per messaggio; rate limit 30 messaggi utente / 10 minuti.
- Segreti (`ANTHROPIC_API_KEY`, `N8N_WEBHOOK_SECRET`, `N8N_BASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) solo lato server; mai con prefisso `NEXT_PUBLIC_`.
- RLS attiva su ogni tabella; `audit_log` solo insert (service role), select solo admin, nessun update/delete.
- Pubblicazione: prima **anteprima Vercel protetta** per la revisione dell'utente; produzione solo dopo sua approvazione esplicita.

## Review Focus

1. **Cambio ora legale**: slot calcolati su giorni di passaggio (25/10/2026, 28/03/2027) devono restare 9–13/14–18 ora di Roma — test in Task 2.
2. **Doppio clic su Conferma**: deve nascere un solo evento — transizione atomica `pending→confirming` e idempotenza su `requestId` in WF2 — test in Task 5.
3. **Conferma tardiva**: proposta confermata quando l'orario è passato o è diventato occupato → rifiuto chiaro, nessun evento — test in Task 5.
4. **Partecipanti sporchi**: nomi ripetuti, il richiedente incluso tra i partecipanti, email esterne o disattivate → normalizzati/rifiutati — test in Task 4.
5. **n8n irraggiungibile o lento**: timeout 10 s, richiesta in stato `failed` con messaggio leggibile, nessun crash della chat — test in Task 3 e Task 5.

---

### Task 1: Scaffold progetto, configurazione e header di sicurezza

**Files:**
- Create: `agenda-app/` (Next.js app con `src/`), `agenda-app/next.config.ts`, `agenda-app/vitest.config.ts`, `agenda-app/.env.example`, `agenda-app/src/lib/env.ts`
- Test: `agenda-app/src/lib/env.test.ts`

**Interfaces:**
- Produces: `serverEnv(): { ANTHROPIC_API_KEY: string; N8N_BASE_URL: string; N8N_WEBHOOK_SECRET: string; SUPABASE_SERVICE_ROLE_KEY: string; ALLOWED_DOMAIN: string }` (zod, lancia se manca qualcosa); `publicEnv: { NEXT_PUBLIC_SUPABASE_URL: string; NEXT_PUBLIC_SUPABASE_ANON_KEY: string }`.

- [ ] **Step 1:** `npx create-next-app@15 agenda-app --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm`; aggiungere dipendenze dello stack; `vitest` con environment `node`; script `"test": "vitest run"`.
- [ ] **Step 2: Test che fallisce** — `env.test.ts`: `serverEnv()` lancia con messaggio contenente `N8N_WEBHOOK_SECRET` se la variabile manca; restituisce i valori quando sono tutte presenti.
- [ ] **Step 3:** `cd agenda-app && npx vitest run src/lib/env.test.ts` → FAIL.
- [ ] **Step 4:** implementare `src/lib/env.ts` (import `server-only` in testa al blocco server).
- [ ] **Step 5:** `next.config.ts` → `headers()` per `/:path*`: `Content-Security-Policy` (`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' <SUPABASE_URL>; frame-ancestors 'none'`), `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- [ ] **Step 6:** `npx vitest run && npm run build` → PASS / build OK.
- [ ] **Step 7:** commit `feat(agenda): scaffold Next.js app with env validation and security headers`.

### Task 2: Calcolo conflitti, slot liberi e festività

**Files:**
- Create: `agenda-app/src/lib/scheduling/types.ts`, `holidays.ts`, `conflicts.ts`, `slots.ts`
- Test: `agenda-app/src/lib/scheduling/holidays.test.ts`, `conflicts.test.ts`, `slots.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type Interval = { start: Date; end: Date }`
  - `type BusyByPerson = Record<string /*email*/, Interval[]>`
  - `type WorkHours = { days: number[] /*1=lun..7=dom*/; ranges: { from: string /*"09:00"*/; to: string }[] }`
  - `const DEFAULT_WORK_HOURS: WorkHours = { days: [1,2,3,4,5], ranges: [{from:"09:00",to:"13:00"},{from:"14:00",to:"18:00"}] }`
- `isItalianHoliday(day: Date): boolean` — giorno valutato in `Europe/Rome`.
- `findConflicts(busy: BusyByPerson, slot: Interval): { email: string; start: Date; end: Date }[]` — sovrapposizione stretta (`a.start < b.end && b.start < a.end`; adiacenti non sono conflitto).
- `findFreeSlots(input: { busy: BusyByPerson; from: Date; to: Date; durationMinutes: number; workHours: WorkHours; closures: string[] /*"YYYY-MM-DD"*/; now: Date; limit?: number /*3*/; stepMinutes?: number /*30*/ }): Interval[]`

- [ ] **Step 1: Test che falliscono**
  - holidays: `true` per 01/01, 06/01, 25/04, 01/05, 02/06, 15/08, 01/11, 08/12, 25/12, 26/12 e Pasquetta 2027 (29/03/2027); `false` per 26/11/2026.
  - conflicts: evento 10:00–11:00 vs slot 10:30–11:30 → 1 conflitto; vs slot 11:00–12:00 → 0.
  - slots: Giulia occupata gio 26/11/2026 10–11, durata 60, from 09:00 to 13:00 → `[09:00–10:00, 11:00–12:00, 12:00–13:00]` (ora di Roma); nessuno slot attraversa 13–14; sabato/domenica/festivi/closures → `[]`; slot che iniziano prima di `now` esclusi; **ora legale**: domenica esclusa, quindi usare lun 26/10/2026 e lun 29/03/2027 → primo slot alle 09:00 Europe/Rome (verificare con `@date-fns/tz`).
- [ ] **Step 2:** `npx vitest run src/lib/scheduling` → FAIL.
- [ ] **Step 3:** implementare. Pasqua con l'algoritmo di Gauss/Meeus (anonimo gregoriano); Pasquetta = Pasqua + 1. Slot: per ogni giorno lavorativo, per ogni range, candidati a passi di `stepMinutes` costruiti con `TZDate` in `Europe/Rome`; tieni quelli con `findConflicts(...)` vuoto; ordina cronologicamente; taglia a `limit`.
- [ ] **Step 4:** `npx vitest run src/lib/scheduling` → PASS.
- [ ] **Step 5:** commit `feat(agenda): conflict detection, free-slot search, Italian holidays`.

### Task 3: Client n8n firmato

**Files:**
- Create: `agenda-app/src/lib/n8n/sign.ts`, `agenda-app/src/lib/n8n/client.ts`
- Test: `agenda-app/src/lib/n8n/sign.test.ts`, `client.test.ts`

**Interfaces:**
- Consumes: `serverEnv()` (Task 1); `Interval`, `BusyByPerson` (Task 2).
- Produces:
  - `signRequest(rawBody: string, secret: string, timestampMs: number): string`
  - `verifyRequest(rawBody: string, secret: string, timestampMs: number, signature: string, nowMs: number): boolean` (stessa logica copiata nel Code node n8n, Task 7)
  - `class N8nError extends Error { kind: "timeout" | "http" | "invalid_response" }`
  - `type N8nClient = { freeBusy(emails: string[], from: Date, to: Date): Promise<{ busy: BusyByPerson; unreadable: string[] }>; createEvent(input: { requestId: string; title: string; description: string; start: Date; end: Date; organizerEmail: string; attendeeEmails: string[]; allowConflict: boolean }): Promise<{ status: "created"; eventId: string; htmlLink: string } | { status: "conflict"; busy: BusyByPerson }>; cancelEvent(input: { requestId: string; googleEventId: string }): Promise<{ status: "cancelled" }> }`
  - `createN8nClient(opts: { baseUrl: string; secret: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number /*10000*/ }): N8nClient`
  - Percorsi webhook: `${baseUrl}/webhook/agenda-freebusy`, `/webhook/agenda-create-event`, `/webhook/agenda-cancel-event`.

- [ ] **Step 1: Test che falliscono**
  - sign: `verifyRequest` true con firma giusta; false con body alterato; false se `nowMs - timestampMs > 300000`.
  - client (fetch finto): `freeBusy` invia header `X-Timestamp` e `X-Signature` validi; risposta con `calendars["x@d"].error` → `x@d` in `unreadable` **e** `busy["x@d"] = [{start: from, end: to}]`; rifiuta (senza chiamare fetch) >15 email o intervallo >14 giorni; fetch che non risponde entro `timeoutMs` → `N8nError` kind `timeout`; risposta non conforme allo schema zod → kind `invalid_response`.
- [ ] **Step 2:** `npx vitest run src/lib/n8n` → FAIL.
- [ ] **Step 3:** implementare con `node:crypto` (`createHmac`, `timingSafeEqual`), `AbortController` per il timeout, zod per le risposte.
- [ ] **Step 4:** `npx vitest run src/lib/n8n` → PASS.
- [ ] **Step 5:** commit `feat(agenda): HMAC-signed n8n client with timeouts and busy-on-error`.

### Task 4: Database Supabase, RLS e repository

**Files:**
- Create: `agenda-app/supabase/migrations/20261126000000_init.sql`, `agenda-app/supabase/tests/rls.test.sql`, `agenda-app/supabase/seed.sql`, `agenda-app/src/lib/db/types.ts` (generato), `agenda-app/src/lib/db/repo.ts`, `agenda-app/src/lib/people.ts`
- Test: `agenda-app/src/lib/people.test.ts`

**Interfaces:**
- Produces (tabelle, oltre allo spec §5.3):
  - `allowed_users(email text pk check (email = lower(email)), full_name text not null, role text check in ('user','admin') default 'user', active bool default true, created_at, created_by uuid)`
  - `profiles(id uuid pk → auth.users on delete cascade, email text unique, full_name text, role text, created_at)`
  - `conversations`, `messages(role text check in ('user','assistant','tool'), content jsonb)`
  - `event_requests(... status text check in ('pending','confirming','confirmed','cancelled','failed') ...)` — `confirming` aggiunto per l'idempotenza
  - `audit_log(id bigserial, actor_id uuid null, actor_email text null, action text, target_type text, target_id text, details jsonb, created_at)`
  - `app_settings(id int pk check (id = 1), allowed_domain text not null, work_hours jsonb not null, updated_at)` e `closures(day date pk, label text)`
  - vista `colleagues` (`security_invoker = true`) = `select email, full_name from allowed_users where active`
  - trigger `before insert on auth.users`: rifiuta (`raise exception`) se `split_part(new.email,'@',2) <> (select allowed_domain from app_settings)` o email non attiva in `allowed_users`; `after insert`: crea `profiles` copiando `role`/`full_name` da `allowed_users`.
  - funzione `is_admin() returns bool security definer set search_path = ''`.
  - `repo.ts`: `type Repo = { listColleagues(): Promise<{email:string; fullName:string}[]>; getSettings(): Promise<{ workHours: WorkHours; closures: string[] }>; insertRequest(r: NewRequest): Promise<EventRequest>; getRequest(id: string, userId: string): Promise<EventRequest | null>; transitionRequest(id: string, userId: string, from: RequestStatus, to: RequestStatus, patch?: Partial<EventRequest>): Promise<EventRequest | null> /*UPDATE ... WHERE status = from RETURNING; null se nessuna riga*/; countUserMessagesSince(userId: string, since: Date): Promise<number>; audit(entry: AuditEntry): Promise<void> }`; `createSupabaseRepo(userClient, serviceClient): Repo` (audit con service client, il resto con client utente → RLS).
  - `people.ts`: `resolveAttendees(input: string[], requesterEmail: string, colleagues: {email:string; fullName:string}[]): { emails: string[]; unknown: string[]; ambiguous: { input: string; options: string[] }[] }` — accetta email o nomi (match case-insensitive su nome intero o nome di battesimo), rimuove duplicati e il richiedente, esterni/disattivati in `unknown`.

- [ ] **Step 1: Test che fallisce** — `people.test.ts`: `["giulia","Giulia Bianchi","marco@d.it","anna@d.it","x@gmail.com"]` con richiedente `anna@d.it` → `emails = ["giulia@d.it","marco@d.it"]`, `unknown = ["x@gmail.com"]`; due "Marco" → `ambiguous`.
- [ ] **Step 2:** `npx vitest run src/lib/people.test.ts` → FAIL; implementare; → PASS.
- [ ] **Step 3:** scrivere la migrazione con RLS come spec §5.3 (+ `app_settings`/`closures`: select per autenticati, scrittura solo `is_admin()`); `seed.sql` con riga `app_settings` (dominio placeholder `example.com`, `DEFAULT_WORK_HOURS`) e il primo admin.
- [ ] **Step 4:** `rls.test.sql` (pgTAP) — utente A non legge `event_requests`/`conversations` di B; utente non admin non legge `audit_log` né scrive `allowed_users`; nessuno (nemmeno admin) può `update`/`delete` su `audit_log`; insert in `auth.users` con email `x@gmail.com` fallisce.
- [ ] **Step 5:** applicare al progetto Supabase di sviluppo (Task 10 crea il progetto; finché non esiste, `supabase db start` locale se Docker è disponibile) e `supabase test db --db-url "$SUPABASE_DB_URL"` → tutti `ok`. Generare `types.ts` con `supabase gen types typescript`.
- [ ] **Step 6:** commit `feat(agenda): schema, RLS policies, domain guard trigger, repository`.

### Task 5: Servizio richieste (proposta, conferma, annullamento)

**Files:**
- Create: `agenda-app/src/lib/requests/service.ts`
- Test: `agenda-app/src/lib/requests/service.test.ts` (Repo in memoria + N8nClient finto)

**Interfaces:**
- Consumes: `Repo` (Task 4), `N8nClient` (Task 3), `findConflicts`, `findFreeSlots` (Task 2), `resolveAttendees` (Task 4).
- Produces:
  - `type Deps = { repo: Repo; n8n: N8nClient; now: () => Date }`
  - `type User = { id: string; email: string; fullName: string }`
  - `checkAvailability(deps, user, input: { attendees: string[]; from: Date; to: Date }): Promise<{ busy: BusyByPerson; unreadable: string[]; unknown: string[]; ambiguous: ... }>` — include sempre il richiedente.
  - `suggestSlots(deps, user, input: { attendees: string[]; durationMinutes: number; from: Date; to: Date }): Promise<{ slots: Interval[]; unreadable: string[]; unknown: string[] }>`
  - `proposeEvent(deps, user, input: { title: string; description?: string; start: Date; end: Date; attendees: string[] }): Promise<{ request: EventRequest; conflicts: {email:string;start:Date;end:Date}[]; unreadable: string[] }>` — crea riga `pending` con `conflict_snapshot`; **nessuna** chiamata a `createEvent`.
  - `confirmRequest(deps, user, id: string, allowConflict: boolean): Promise<{ status: "confirmed"; htmlLink: string } | { status: "conflict"; conflicts: ... } | { status: "error"; message: string }>`
  - `cancelRequest(deps, user, id: string): Promise<{ status: "cancelled" } | { status: "error"; message: string }>`
  - Ogni operazione chiama `repo.audit` con `action` ∈ `availability_checked | event_proposed | event_confirmed | event_confirmed_with_conflict | event_cancelled | event_failed`.

- [ ] **Step 1: Test che falliscono**
  - `proposeEvent` non chiama `n8n.createEvent`; con Giulia occupata salva `conflicts` non vuoto.
  - `confirmRequest` su richiesta di un altro utente → `error` e nessuna chiamata n8n.
  - **doppio clic**: due `confirmRequest` concorrenti (`Promise.all`) → `createEvent` chiamato una volta; il secondo riceve `error` "già in conferma".
  - **conferma tardiva**: `now` dopo `start` → `error` "orario già passato", nessuna chiamata; n8n risponde `conflict` con `allowConflict=false` → stato torna `pending`, ritorna `conflict`.
  - `allowConflict=true` passa a n8n e l'audit è `event_confirmed_with_conflict`.
  - n8n lancia `N8nError("timeout")` → stato `failed`, `error` = "Il calendario non risponde, riprova tra poco."
  - `cancelRequest`: su `pending` → `cancelled` senza n8n; su `confirmed` → chiama `cancelEvent` poi `cancelled`; su `cancelled` → `error`.
- [ ] **Step 2:** `npx vitest run src/lib/requests` → FAIL.
- [ ] **Step 3:** implementare; conferma = `transitionRequest(id, user.id, "pending", "confirming")` → se `null` errore; poi n8n; poi `confirming→confirmed|pending|failed`.
- [ ] **Step 4:** `npx vitest run src/lib/requests` → PASS.
- [ ] **Step 5:** commit `feat(agenda): event request service with atomic confirmation and audit`.

### Task 6: Auth Google, guardia dominio, middleware

**Files:**
- Create: `agenda-app/src/lib/supabase/server.ts`, `client.ts`, `admin.ts`, `agenda-app/src/lib/auth/session.ts`, `agenda-app/src/middleware.ts`, `agenda-app/src/app/login/page.tsx`, `agenda-app/src/app/auth/callback/route.ts`, `agenda-app/src/lib/auth/domain.ts`
- Test: `agenda-app/src/lib/auth/domain.test.ts`, `agenda-app/src/middleware.test.ts`

**Interfaces:**
- Produces:
  - `isAllowedEmail(email: string | undefined, domain: string): boolean` — lower-case, esattamente un `@`, dominio identico (non suffisso: `x@evil-example.com` e `x@example.com.evil` → false).
  - `requireUser(): Promise<User & { role: "user" | "admin" }>` (redirect a `/login` se assente) e `requireAdmin()` (404 se non admin).
  - `createServerSupabase()`, `createServiceSupabase()` (`server-only`).
- [ ] **Step 1: Test che falliscono** — casi `isAllowedEmail` sopra; middleware: richiesta a `/` senza sessione → redirect `/login`; `/login` e `/auth/callback` passano.
- [ ] **Step 2:** FAIL → implementare → `npx vitest run src/lib/auth src/middleware.test.ts` PASS.
- [ ] **Step 3:** `/login` come schermata "Login" del design (pulsante `signInWithOAuth({ provider: "google", options: { queryParams: { hd: ALLOWED_DOMAIN, prompt: "select_account" }, redirectTo: <origin>/auth/callback } })`, messaggio d'errore con `?error=denied`). Callback: `exchangeCodeForSession`; se `!isAllowedEmail` o non attivo in `allowed_users` → `signOut`, `audit("login_denied")`, redirect `/login?error=denied`.
- [ ] **Step 4:** `npm run build` OK; commit `feat(agenda): Google login restricted to company domain`.

### Task 7: Workflow n8n

**Files:**
- Create: `agenda-app/n8n/agenda-freebusy.json`, `agenda-create-event.json`, `agenda-cancel-event.json` (export), `agenda-app/n8n/verify-signature.js` (codice del Code node, identico a `verifyRequest`)
- Test: esecuzioni di test n8n

**Interfaces:**
- Consumes: contratti di Task 3 (percorsi, body, risposte).
- Struttura di ogni workflow: Webhook (POST, `Raw body` attivo, risposta "Using Respond node") → Code "Verifica firma" (secret dalla credenziale/variabile n8n `AGENDA_WEBHOOK_SECRET`; se falso → Respond 401) → Code "Valida input" (stessi limiti di Task 3) → nodi Google Calendar con credenziale `agenda@` → Respond JSON.
  - freebusy: HTTP Request `POST https://www.googleapis.com/calendar/v3/freeBusy` con `timeZone: "Europe/Rome"` e `items` = email; risposta `{ calendars: { [email]: { busy: [{start,end}], error?: string } } }`.
  - create-event: ricerca evento con `privateExtendedProperty=agendaRequestId=<requestId>` sul calendario condiviso (`AGENDA_SHARED_CALENDAR_ID`) → se esiste restituiscilo; altrimenti freebusy sui partecipanti + organizzatore; conflitto e `allowConflict=false` → `{status:"conflict",busy}`; altrimenti crea evento con `attendees`, `sendUpdates=all`, `extendedProperties.private.agendaRequestId`, descrizione `"<descrizione>\n\nCreato da <organizerEmail> tramite Agenda aziendale"` → `{status:"created",eventId,htmlLink}`.
  - cancel-event: verifica che l'evento abbia `agendaRequestId = requestId`, poi delete con `sendUpdates=all` → `{status:"cancelled"}`.
- [ ] **Step 1:** leggere preferenze/contesto istanza n8n e riferimento SDK (via MCP n8n), poi creare i tre workflow **disattivati**.
- [ ] **Step 2:** test con richiesta non firmata → 401; firmata con 2 email di prova → solo intervalli busy, nessun `summary` nella risposta.
- [ ] **Step 3:** test create-event due volte con stesso `requestId` → un solo evento; poi cancel-event → evento rimosso.
- [ ] **Step 4:** esportare i JSON in `agenda-app/n8n/` (senza credenziali), commit `feat(agenda): n8n workflows for freebusy, create and cancel`.

### Task 8: Assistente AI e chat

**Files:**
- Create: `agenda-app/src/lib/agent/system-prompt.ts`, `agenda-app/src/lib/agent/tools.ts`, `agenda-app/src/app/api/chat/route.ts`, `agenda-app/src/app/(app)/page.tsx`, `agenda-app/src/components/chat/*`, `agenda-app/src/components/proposal-card.tsx`, `agenda-app/src/app/api/requests/[id]/confirm/route.ts`, `.../cancel/route.ts`
- Test: `agenda-app/src/lib/agent/tools.test.ts`, `system-prompt.test.ts`, `agenda-app/src/app/api/requests/confirm.test.ts`

**Interfaces:**
- Consumes: servizio di Task 5, `requireUser` (Task 6), `createN8nClient`, `createSupabaseRepo`.
- Produces:
  - `buildSystemPrompt(now: Date, workHours: WorkHours): string` — italiano; contiene data e giorno della settimana correnti in `Europe/Rome` (es. "giovedì 26 novembre 2026"), orario lavorativo, regole: usa sempre i tool, non inventare disponibilità, non conosci i dettagli degli impegni altrui, non puoi creare eventi (solo proporli: l'utente conferma col pulsante), chiedi chiarimenti se un nome è ambiguo.
  - `buildTools(deps: Deps, user: User)` → `{ list_colleagues, check_availability, find_free_slots, propose_event }` (AI SDK `tool()` con `inputSchema` zod; date in ISO con offset; `durationMinutes` 15–480).
  - `propose_event` restituisce `{ requestId, title, start, end, attendees, conflicts, unreadable }`, reso in chat come `<ProposalCard>` (design "Main": verde "Nessun conflitto" + Conferma/Annulla; arancione "N conflitti" + "Conferma comunque").
  - Route `POST /api/chat`: `requireUser`; rate limit con `countUserMessagesSince(now-10min) >= 30` → 429 "Troppi messaggi, riprova tra qualche minuto."; `streamText({ model: anthropic("claude-sonnet-5-5"), system, messages, tools, stopWhen: stepCountIs(8) })`; salva messaggi in `conversations`/`messages`.
  - `POST /api/requests/:id/confirm` body `{ allowConflict: boolean }` → `confirmRequest`; `POST /api/requests/:id/cancel` → `cancelRequest`. Entrambe: `requireUser`, verifica header `Origin` uguale all'host (CSRF), 401 senza sessione.
- [ ] **Step 1: Test che falliscono** — system prompt contiene il giorno della settimana corretto per `2026-11-26T08:00Z` ("giovedì"); `buildTools` espone esattamente i 4 nomi (nessuno crea eventi); `find_free_slots` con durata 0 → errore di validazione; confirm route senza sessione → 401, con `Origin` estraneo → 403.
- [ ] **Step 2:** FAIL → implementare → `npx vitest run src/lib/agent src/app/api` PASS.
- [ ] **Step 3:** UI chat e layout `(app)` con header/nav come nel design (voce "Amministrazione" solo per admin).
- [ ] **Step 4:** `npm run build` OK; commit `feat(agenda): AI assistant with scheduling tools and confirmation card`.

### Task 9: Pagine Nuova riunione, Le mie richieste, Amministrazione

**Files:**
- Create: `agenda-app/src/app/(app)/nuova/page.tsx`, `agenda-app/src/app/(app)/richieste/page.tsx`, `agenda-app/src/app/(app)/admin/page.tsx`, `agenda-app/src/app/api/availability/route.ts`, `agenda-app/src/app/(app)/admin/actions.ts`
- Test: `agenda-app/src/app/(app)/admin/actions.test.ts`

**Interfaces:**
- Consumes: `suggestSlots`, `proposeEvent`, `confirmRequest`, `cancelRequest` (Task 5); `requireAdmin` (Task 6).
- Produces: Server Actions admin `addAllowedUser({email, fullName, role})`, `setUserActive(email, active)`, `updateWorkHours(workHours)`, `addClosure(day, label)`, `removeClosure(day)` — tutte `requireAdmin()`, validate con zod, scrivono `audit`. `addAllowedUser` rifiuta email fuori `ALLOWED_DOMAIN`. Admin non può disattivare sé stesso.
- [ ] **Step 1: Test che falliscono** — `addAllowedUser` da non admin → errore; email `x@gmail.com` → errore; `setUserActive(proprio email,false)` → errore.
- [ ] **Step 2:** FAIL → implementare → PASS.
- [ ] **Step 3:** pagine come le schermate "Nuova", "Richieste", "Admin" del design: timeline libero/occupato senza titoli, filtri stato, registro attività filtrabile per `action` (ultimi 200).
- [ ] **Step 4:** `npm run build` OK; commit `feat(agenda): new-meeting form, my requests, admin pages`.

### Task 10: Collegamento ambienti e anteprima per la revisione

Questo task richiede dall'utente: dominio aziendale, account `agenda@` con scrittura sul calendario condiviso e ID del calendario, OAuth client Google (Google Cloud Console) per Supabase Auth, chiave API Anthropic, conferma di condivisione libero/occupato nel dominio.

- [ ] **Step 1:** creare il progetto Supabase (MCP, regione UE, dopo conferma del costo dall'utente); applicare migrazione e seed con il dominio reale; eseguire `rls.test.sql` → tutti `ok`; `get_advisors` sicurezza → nessun avviso critico.
- [ ] **Step 2:** configurare provider Google in Supabase Auth con il client dell'utente; redirect URL dell'anteprima Vercel.
- [ ] **Step 3:** attivare i workflow n8n; test reale di freebusy sui 10 indirizzi → nessun `unreadable` (prerequisito spec §6).
- [ ] **Step 4:** progetto Vercel collegato a `agenda-app/`, variabili d'ambiente (server-only come Global Constraints), **Deployment Protection attiva**; deploy di **anteprima**, non produzione.
- [ ] **Step 5:** checklist manuale sull'anteprima: login con account esterno rifiutato; proposta senza conflitto → evento creato e inviti ricevuti; doppio clic → un evento; conferma con conflitto solo via "Conferma comunque"; annullamento → evento rimosso; header di sicurezza presenti (`curl -I`).
- [ ] **Step 6:** consegnare link anteprima all'utente per la revisione. Promozione a produzione **solo** dopo sua approvazione esplicita.
