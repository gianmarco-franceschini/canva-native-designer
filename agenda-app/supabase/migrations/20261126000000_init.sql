-- Agenda aziendale — schema iniziale, RLS, guardia di dominio sugli utenti.
-- Principio: ogni tabella ha RLS attiva; `anon` non ha alcun privilegio sulle tabelle
-- dell'app; `audit_log` è append-only (insert solo service_role, select solo admin).

-- ---------------------------------------------------------------------------
-- Tabelle
-- ---------------------------------------------------------------------------

create table public.app_settings (
  id int primary key default 1 check (id = 1),
  allowed_domain text not null check (allowed_domain = lower(allowed_domain) and allowed_domain <> ''),
  work_hours jsonb not null,
  updated_at timestamptz not null default now()
);

create table public.closures (
  day date primary key,
  label text
);

create table public.allowed_users (
  email text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  full_name text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now()
);
create index conversations_user_id_idx on public.conversations (user_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content jsonb not null,
  created_at timestamptz not null default now()
);
create index messages_conversation_id_idx on public.messages (conversation_id, created_at);

create table public.event_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  attendee_emails text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'confirming', 'confirmed', 'cancelled', 'failed')),
  conflict_snapshot jsonb,
  google_event_id text,
  google_event_link text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  error text,
  check (end_at > start_at)
);
create index event_requests_user_id_idx on public.event_requests (user_id, created_at desc);

-- Nessuna FK verso auth.users: il registro deve sopravvivere alla cancellazione degli utenti.
create table public.audit_log (
  id bigserial primary key,
  actor_id uuid,
  actor_email text,
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_created_at_idx on public.audit_log (created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

-- ---------------------------------------------------------------------------
-- Funzioni
-- ---------------------------------------------------------------------------

-- Admin = profilo collegato a una voce attiva di allowed_users con ruolo admin.
-- allowed_users è la fonte di verità: disattivare o declassare ha effetto immediato.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.allowed_users a on a.email = p.email
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and a.role = 'admin'
      and a.active
  );
$$;

-- Guardia di dominio: rifiuta la creazione (o il cambio email) di utenti fuori dominio
-- o non attivi in allowed_users. Se app_settings manca rifiuta comunque (fail closed).
create function public.guard_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text;
  v_email text := lower(new.email);
begin
  select s.allowed_domain into v_domain from public.app_settings s where s.id = 1;
  if v_domain is null then
    raise exception 'accesso negato: configurazione dominio assente' using errcode = '42501';
  end if;
  if v_email is null
     or v_email !~ '^[^@\s]+@[^@\s]+$'
     or split_part(v_email, '@', 2) <> v_domain then
    raise exception 'accesso negato: email fuori dominio' using errcode = '42501';
  end if;
  if not exists (select 1 from public.allowed_users a where a.email = v_email and a.active) then
    raise exception 'accesso negato: utente non autorizzato' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  select new.id, a.email, a.full_name, a.role
  from public.allowed_users a
  where a.email = lower(new.email);
  return new;
end;
$$;

create function public.handle_auth_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles p
  set email = a.email, full_name = a.full_name, role = a.role
  from public.allowed_users a
  where p.id = new.id and a.email = lower(new.email);
  return new;
end;
$$;

-- Mantiene profiles allineato a allowed_users (ruolo e nome gestiti dall'admin).
create function public.sync_profile_from_allowed_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles p
  set full_name = new.full_name, role = new.role
  where p.email = new.email;
  return new;
end;
$$;

create function public.reject_audit_log_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log è immutabile' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------

create trigger guard_auth_user_insert
  before insert on auth.users
  for each row execute function public.guard_auth_user();

create trigger guard_auth_user_email_update
  before update of email on auth.users
  for each row when (new.email is distinct from old.email)
  execute function public.guard_auth_user();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (new.email is distinct from old.email)
  execute function public.handle_auth_user_email_change();

create trigger sync_profile_on_allowed_user_update
  after update of full_name, role on public.allowed_users
  for each row execute function public.sync_profile_from_allowed_user();

create trigger audit_log_immutable
  before update or delete on public.audit_log
  for each row execute function public.reject_audit_log_change();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.reject_audit_log_change();

-- ---------------------------------------------------------------------------
-- Rubrica: solo nome/email dei colleghi attivi. SECURITY DEFINER così i non admin
-- non hanno alcun accesso diretto ad allowed_users (ruoli, created_by, disattivati).
-- ---------------------------------------------------------------------------

create function public.list_colleagues()
returns table (email text, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.email, a.full_name
  from public.allowed_users a
  where a.active
  order by a.full_name, a.email;
$$;

-- ---------------------------------------------------------------------------
-- Privilegi
-- ---------------------------------------------------------------------------

revoke all on
  public.app_settings, public.closures, public.allowed_users, public.profiles,
  public.conversations, public.messages, public.event_requests, public.audit_log
from public, anon, authenticated;
revoke all on sequence public.audit_log_id_seq from public, anon, authenticated;

grant select, update on public.app_settings to authenticated;
grant select, insert, update, delete on public.closures to authenticated;
grant select, insert, update on public.allowed_users to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
-- event_requests: l'utente legge le proprie; scritture solo lato server (service_role)
-- dopo il controllo di proprietà, così lo stato non è manipolabile via PostgREST.
grant select on public.event_requests to authenticated;
grant select on public.audit_log to authenticated;

-- service_role scavalca la RLS: per audit_log contano solo i privilegi.
revoke all on public.audit_log from service_role;
grant select, insert on public.audit_log to service_role;
grant usage on sequence public.audit_log_id_seq to service_role;

-- Le tabelle create in futuro non devono essere esposte ad anon per default.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

revoke execute on function
  public.is_admin(),
  public.guard_auth_user(),
  public.handle_new_auth_user(),
  public.handle_auth_user_email_change(),
  public.sync_profile_from_allowed_user(),
  public.reject_audit_log_change(),
  public.list_colleagues()
from public, anon, authenticated;
revoke execute on function public.list_colleagues() from service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.list_colleagues() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.app_settings enable row level security;
alter table public.closures enable row level security;
alter table public.allowed_users enable row level security;
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.event_requests enable row level security;
alter table public.audit_log enable row level security;

-- app_settings / closures: lettura per autenticati, scrittura solo admin.
create policy app_settings_select on public.app_settings
  for select to authenticated using (true);
create policy app_settings_update on public.app_settings
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy closures_select on public.closures
  for select to authenticated using (true);
create policy closures_insert on public.closures
  for insert to authenticated with check ((select public.is_admin()));
create policy closures_update on public.closures
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy closures_delete on public.closures
  for delete to authenticated using ((select public.is_admin()));

-- allowed_users: solo admin (i colleghi passano da list_colleagues()).
create policy allowed_users_select on public.allowed_users
  for select to authenticated using ((select public.is_admin()));
create policy allowed_users_insert on public.allowed_users
  for insert to authenticated with check ((select public.is_admin()));
create policy allowed_users_update on public.allowed_users
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- profiles: ognuno il proprio, admin tutti. Scrittura solo via trigger.
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- conversations / messages: solo le proprie righe.
create policy conversations_select on public.conversations
  for select to authenticated using (user_id = (select auth.uid()));
create policy conversations_insert on public.conversations
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy conversations_update on public.conversations
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy conversations_delete on public.conversations
  for delete to authenticated using (user_id = (select auth.uid()));

create policy messages_select on public.messages
  for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = conversation_id and c.user_id = (select auth.uid())
  ));
create policy messages_insert on public.messages
  for insert to authenticated
  with check (exists (
    select 1 from public.conversations c
    where c.id = conversation_id and c.user_id = (select auth.uid())
  ));

-- event_requests: select delle proprie righe; nessuna policy di scrittura.
create policy event_requests_select on public.event_requests
  for select to authenticated using (user_id = (select auth.uid()));

-- audit_log: select solo admin; nessuna policy di scrittura (insert solo service_role).
create policy audit_log_select on public.audit_log
  for select to authenticated using ((select public.is_admin()));
