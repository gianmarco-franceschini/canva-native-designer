-- pgTAP: RLS, privilegi, guardia di dominio. Tutto in una transazione annullata alla fine.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

-- ---------------------------------------------------------------------------
-- Fixture (come postgres, prima dell'impersonazione)
-- ---------------------------------------------------------------------------
insert into public.app_settings (id, allowed_domain, work_hours)
values (1, 'example.com', '{"days":[1],"ranges":[]}')
on conflict (id) do update set allowed_domain = excluded.allowed_domain;

insert into public.allowed_users (email, full_name, role, active) values
  ('rls-a@example.com',    'Anna Test',   'user',  true),
  ('rls-b@example.com',    'Bruno Test',  'user',  true),
  ('rls-capo@example.com', 'Capo Test',   'admin', true),
  ('rls-ex@example.com',   'Ex Collega',  'user',  false),
  ('rls-new@example.com',  'Nuovo Test',  'user',  true);

-- Guardia di dominio ----------------------------------------------------------
select throws_ok(
  $$ insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f1', 'x@gmail.com') $$,
  '42501', 'accesso negato: email fuori dominio',
  'auth.users: email fuori dominio rifiutata'
);
select throws_ok(
  $$ insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f2', 'x@example.com@gmail.com') $$,
  '42501', 'accesso negato: email fuori dominio',
  'auth.users: email con più @ rifiutata'
);
select throws_ok(
  $$ insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f3', 'ignoto@example.com') $$,
  '42501', 'accesso negato: utente non autorizzato',
  'auth.users: email di dominio ma assente da allowed_users rifiutata'
);
select throws_ok(
  $$ insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f4', 'rls-ex@example.com') $$,
  '42501', 'accesso negato: utente non autorizzato',
  'auth.users: utente disattivato rifiutato'
);
select throws_ok(
  $$ insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f5', 'x@sub.example.com') $$,
  '42501', 'accesso negato: email fuori dominio',
  'auth.users: sottodominio rifiutato'
);

select lives_ok(
  $$ insert into auth.users (id, email) values
       ('00000000-0000-0000-0000-00000000000a', 'RLS-A@Example.com'),
       ('00000000-0000-0000-0000-00000000000b', 'rls-b@example.com'),
       ('00000000-0000-0000-0000-00000000000c', 'rls-capo@example.com') $$,
  'auth.users: utenti di dominio attivi accettati (email case-insensitive)'
);

select results_eq(
  $$ select email, full_name, role from public.profiles
     where id = '00000000-0000-0000-0000-00000000000a' $$,
  $$ values ('rls-a@example.com'::text, 'Anna Test'::text, 'user'::text) $$,
  'profiles: creato al primo login copiando nome/ruolo da allowed_users'
);
select is(
  (select role from public.profiles where id = '00000000-0000-0000-0000-00000000000c'),
  'admin', 'profiles: ruolo admin copiato'
);

select throws_ok(
  $$ update auth.users set email = 'rls-a@gmail.com' where id = '00000000-0000-0000-0000-00000000000a' $$,
  '42501', 'accesso negato: email fuori dominio',
  'auth.users: cambio email verso un altro dominio rifiutato'
);

-- Dati di A e B
insert into public.conversations (id, user_id, title) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'conv A'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'conv B');
insert into public.messages (conversation_id, role, content) values
  ('10000000-0000-0000-0000-00000000000a', 'user', '"ciao da A"'),
  ('10000000-0000-0000-0000-00000000000b', 'user', '"ciao da B"');
insert into public.event_requests (id, user_id, title, start_at, end_at, attendee_emails) values
  ('20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'riunione A',
   '2026-12-01 09:00+01', '2026-12-01 10:00+01', '{rls-b@example.com}'),
  ('20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'riunione B',
   '2026-12-01 11:00+01', '2026-12-01 12:00+01', '{rls-a@example.com}');
insert into public.audit_log (actor_id, action, target_type) values
  ('00000000-0000-0000-0000-00000000000a', 'fixture', 'test');

-- ---------------------------------------------------------------------------
-- Utente A (non admin)
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select is((select public.is_admin()), false, 'A: is_admin() falso');

select results_eq(
  $$ select id from public.event_requests $$,
  $$ values ('20000000-0000-0000-0000-00000000000a'::uuid) $$,
  'A: vede solo le proprie event_requests'
);
select is_empty(
  $$ select 1 from public.event_requests where user_id = '00000000-0000-0000-0000-00000000000b' $$,
  'A: non legge le event_requests di B'
);
select is_empty(
  $$ select 1 from public.conversations where user_id = '00000000-0000-0000-0000-00000000000b' $$,
  'A: non legge le conversations di B'
);
select is(
  (select count(*)::int from public.conversations), 1, 'A: vede solo la propria conversation'
);
select is_empty(
  $$ select 1 from public.messages where conversation_id = '10000000-0000-0000-0000-00000000000b' $$,
  'A: non legge i messages di B'
);
select throws_ok(
  $$ insert into public.messages (conversation_id, role, content)
     values ('10000000-0000-0000-0000-00000000000b', 'user', '"intruso"') $$,
  '42501', null, 'A: non scrive messages nella conversation di B'
);
select throws_ok(
  $$ update public.event_requests set title = 'hack'
     where id = '20000000-0000-0000-0000-00000000000b' $$,
  '42501', null, 'A: non modifica le event_requests di B'
);
select throws_ok(
  $$ update public.event_requests set status = 'confirmed', google_event_id = 'finto'
     where id = '20000000-0000-0000-0000-00000000000a' $$,
  '42501', null, 'A: non modifica nemmeno le proprie event_requests (stato non manipolabile)'
);
select throws_ok(
  $$ insert into public.event_requests (user_id, title, start_at, end_at)
     values ('00000000-0000-0000-0000-00000000000b', 'finta', now(), now() + interval '1 hour') $$,
  '42501', null, 'A: non crea event_requests a nome di B'
);
select throws_ok(
  $$ insert into public.event_requests (title, start_at, end_at, status)
     values ('già confermata', now(), now() + interval '1 hour', 'confirmed') $$,
  '42501', null, 'A: non crea event_requests già confermate'
);
select throws_ok(
  $$ insert into public.event_requests (user_id, title, start_at, end_at)
     values ('00000000-0000-0000-0000-00000000000a', 'mia', now(), now() + interval '1 hour') $$,
  '42501', null, 'A: non inserisce event_requests nemmeno a proprio nome (solo lato server)'
);
select is_empty($$ select 1 from public.audit_log $$, 'A: non legge audit_log');
select throws_ok(
  $$ insert into public.audit_log (action, target_type) values ('falso', 'test') $$,
  '42501', null, 'A: non scrive audit_log'
);
select throws_ok(
  $$ insert into public.allowed_users (email, full_name) values ('rls-z@example.com', 'Z') $$,
  '42501', null, 'A: non inserisce in allowed_users'
);
select is_empty(
  $$ update public.allowed_users set role = 'admin' where email = 'rls-a@example.com' returning email $$,
  'A: non modifica allowed_users (nemmeno sé stesso)'
);
select throws_ok(
  $$ delete from public.allowed_users where email = 'rls-b@example.com' $$,
  '42501', null, 'A: nessun privilegio delete su allowed_users'
);
select is_empty(
  $$ select 1 from public.allowed_users $$,
  'A: non legge allowed_users (nemmeno le righe attive)'
);
select results_eq(
  $$ select email, full_name from public.list_colleagues() where email like 'rls-%' order by email $$,
  $$ values ('rls-a@example.com'::text, 'Anna Test'::text),
            ('rls-b@example.com', 'Bruno Test'),
            ('rls-capo@example.com', 'Capo Test'),
            ('rls-new@example.com', 'Nuovo Test') $$,
  'A: list_colleagues() restituisce solo nome/email dei colleghi attivi'
);
select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('00000000-0000-0000-0000-00000000000a'::uuid) $$,
  'A: legge solo il proprio profilo'
);
select throws_ok(
  $$ update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-00000000000a' $$,
  '42501', null, 'A: non modifica il proprio ruolo'
);
select is(
  (select allowed_domain from public.app_settings), 'example.com', 'A: legge app_settings'
);
select is_empty(
  $$ update public.app_settings set allowed_domain = 'gmail.com' returning id $$,
  'A: non modifica app_settings'
);
select throws_ok(
  $$ insert into public.closures (day, label) values ('2026-12-24', 'chiuso') $$,
  '42501', null, 'A: non scrive closures'
);

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);

select is((select public.is_admin()), true, 'admin: is_admin() vero');
select isnt_empty($$ select 1 from public.audit_log $$, 'admin: legge audit_log');
select throws_ok(
  $$ update public.audit_log set action = 'modificato' $$,
  '42501', null, 'admin: non modifica audit_log'
);
select throws_ok(
  $$ delete from public.audit_log $$,
  '42501', null, 'admin: non cancella audit_log'
);
select lives_ok(
  $$ insert into public.allowed_users (email, full_name) values ('rls-z@example.com', 'Zeta Test') $$,
  'admin: inserisce in allowed_users'
);
select lives_ok(
  $$ insert into public.closures (day, label) values ('2026-12-24', 'chiuso') $$,
  'admin: scrive closures'
);
select is(
  (select count(*)::int from public.profiles where email like 'rls-%'), 3,
  'admin: legge tutti i profili'
);
select is_empty(
  $$ select 1 from public.event_requests where user_id = '00000000-0000-0000-0000-00000000000a' $$,
  'admin: non legge le event_requests altrui'
);

-- ---------------------------------------------------------------------------
-- service_role: audit_log solo insert/select
-- ---------------------------------------------------------------------------
set local role service_role;
select lives_ok(
  $$ insert into public.audit_log (action, target_type, details) values ('test', 'test', '{"ok":true}') $$,
  'service_role: inserisce in audit_log'
);
select throws_ok(
  $$ update public.audit_log set action = 'modificato' $$,
  '42501', null, 'service_role: non modifica audit_log'
);
select throws_ok(
  $$ delete from public.audit_log $$,
  '42501', null, 'service_role: non cancella audit_log'
);
select throws_ok(
  $$ truncate public.audit_log $$,
  '42501', null, 'service_role: non svuota audit_log'
);
select lives_ok(
  $$ insert into public.event_requests (user_id, title, start_at, end_at)
     values ('00000000-0000-0000-0000-00000000000a', 'via server', now(), now() + interval '1 hour') $$,
  'service_role: inserisce event_requests con user_id esplicito'
);
select results_eq(
  $$ update public.event_requests set status = 'confirming'
     where id = '20000000-0000-0000-0000-00000000000a'
       and user_id = '00000000-0000-0000-0000-00000000000a' and status = 'pending'
     returning status $$,
  $$ values ('confirming'::text) $$,
  'service_role: transizione condizionale riuscita'
);
select is_empty(
  $$ update public.event_requests set status = 'confirming'
     where id = '20000000-0000-0000-0000-00000000000a'
       and user_id = '00000000-0000-0000-0000-00000000000a' and status = 'pending'
     returning status $$,
  'service_role: la stessa transizione ripetuta non tocca righe'
);

-- ---------------------------------------------------------------------------
-- anon: nessun accesso
-- ---------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok($$ select 1 from public.event_requests $$, '42501', null, 'anon: nessun accesso a event_requests');
select throws_ok($$ select * from public.list_colleagues() $$, '42501', null, 'anon: non esegue list_colleagues()');
select throws_ok($$ select 1 from public.allowed_users $$, '42501', null, 'anon: nessun accesso a allowed_users');

-- ---------------------------------------------------------------------------
-- Owner e invarianti di schema
-- ---------------------------------------------------------------------------
reset role;
select throws_ok(
  $$ delete from public.audit_log $$,
  '42501', 'audit_log è immutabile', 'owner: audit_log immutabile anche per il proprietario'
);
select is(
  (select count(*)::int from pg_tables where schemaname = 'public' and not rowsecurity), 0,
  'RLS attiva su ogni tabella di public'
);

-- Disattivare l'admin in allowed_users ha effetto immediato su is_admin().
update public.allowed_users set active = false where email = 'rls-capo@example.com';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}', true);
select is((select public.is_admin()), false, 'admin disattivato: is_admin() falso');
reset role;

-- Il ruolo assegnato dall'admin si propaga a profiles.
update public.allowed_users set role = 'admin' where email = 'rls-a@example.com';
select is(
  (select role from public.profiles where id = '00000000-0000-0000-0000-00000000000a'),
  'admin', 'allowed_users → profiles: ruolo sincronizzato'
);

-- Senza app_settings nessuna registrazione passa (fail closed).
delete from public.app_settings;
select throws_ok(
  $$ insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000f6', 'rls-new@example.com') $$,
  '42501', 'accesso negato: configurazione dominio assente',
  'auth.users: app_settings assente → rifiuto'
);

select * from finish();
rollback;
