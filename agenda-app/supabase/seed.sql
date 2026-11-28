-- Dati iniziali. Sostituire dominio ed email del primo admin prima del deploy.
-- work_hours = DEFAULT_WORK_HOURS (src/lib/scheduling/types.ts).
insert into public.app_settings (id, allowed_domain, work_hours)
values (
  1,
  'example.com',
  '{"days":[1,2,3,4,5],"ranges":[{"from":"09:00","to":"13:00"},{"from":"14:00","to":"18:00"}]}'::jsonb
)
on conflict (id) do nothing;

insert into public.allowed_users (email, full_name, role)
values ('admin@example.com', 'Amministratore', 'admin')
on conflict (email) do nothing;
