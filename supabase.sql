-- Ten a Week: run this once in Supabase → SQL Editor → New query → Run.

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people(id) on delete cascade,
  day date not null,
  link text,
  created_at timestamptz not null default now()
);
create index if not exists videos_day_idx on public.videos(day);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);
insert into public.settings(key, value) values ('target', '10') on conflict do nothing;

-- The app has no logins: anyone with the site link can view and edit.
alter table public.people   enable row level security;
alter table public.videos   enable row level security;
alter table public.settings enable row level security;

drop policy if exists "team access" on public.people;
drop policy if exists "team access" on public.videos;
drop policy if exists "team access" on public.settings;
create policy "team access" on public.people   for all to anon using (true) with check (true);
create policy "team access" on public.videos   for all to anon using (true) with check (true);
create policy "team access" on public.settings for all to anon using (true) with check (true);

-- live updates, so everyone's screen refreshes when someone taps +
alter publication supabase_realtime add table public.people, public.videos, public.settings;
