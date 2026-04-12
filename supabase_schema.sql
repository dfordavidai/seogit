-- ============================================================
-- SEO PARASITE PRO v17 — Supabase SQL Schema
-- Paste this entire file into: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- Enable UUID extension (usually already enabled)
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. PROJECTS — top-level grouping for multi-site use
-- ============================================================
create table if not exists spp_projects (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  description  text,
  color        text default '#003087',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ============================================================
-- 2. KEYWORDS — master keyword list
-- ============================================================
create table if not exists spp_keywords (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  keyword     text not null,
  volume      integer,
  difficulty  integer,
  intent      text check (intent in ('informational','commercial','transactional','navigational','all')),
  notes       text,
  tags        text[],
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (project_id, keyword)
);
create index if not exists idx_keywords_project on spp_keywords(project_id);
create index if not exists idx_keywords_kw      on spp_keywords(keyword);

-- ============================================================
-- 3. LINKS / BACKLINKS — parasite post URLs and backlinks
-- ============================================================
create table if not exists spp_links (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references spp_projects(id) on delete cascade,
  url          text not null,
  keyword      text,
  platform     text,
  anchor       text,
  target_url   text,
  status       text default 'pending' check (status in ('pending','live','dead','checking','changed')),
  http_code    integer,
  da           integer,
  dr           integer,
  last_checked timestamptz,
  published_at timestamptz,
  notes        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists idx_links_project on spp_links(project_id);
create index if not exists idx_links_status  on spp_links(status);
create index if not exists idx_links_keyword on spp_links(keyword);

-- ============================================================
-- 4. ACCOUNTS — platform login credentials (encrypted at rest via Supabase Vault ideally)
-- ============================================================
create table if not exists spp_accounts (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  platform    text not null,   -- 'wordpress', 'blogger', 'medium', etc.
  label       text,
  login       text,
  site_url    text,
  -- DO NOT store raw passwords in production — use Supabase Vault or encrypt client-side
  token_hint  text,            -- first 8 chars of token for identification only
  connected   boolean default false,
  last_used   timestamptz,
  post_count  integer default 0,
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists idx_accounts_project  on spp_accounts(project_id);
create index if not exists idx_accounts_platform on spp_accounts(platform);

-- ============================================================
-- 5. JOBS — background job queue (rank tracking, blog commenting runs, etc.)
-- ============================================================
create table if not exists spp_jobs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  type        text not null,   -- 'rank_check', 'bc_run', 'ping', 'index', 'link_check'
  status      text default 'pending' check (status in ('pending','running','done','failed','paused')),
  payload     jsonb default '{}',
  result      jsonb default '{}',
  progress    integer default 0,   -- 0-100
  log         text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists idx_jobs_project on spp_jobs(project_id);
create index if not exists idx_jobs_status  on spp_jobs(status);
create index if not exists idx_jobs_type    on spp_jobs(type);

-- ============================================================
-- 6. SESSIONS — proxy / identity session management
-- ============================================================
create table if not exists spp_sessions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  label       text,
  proxy       text,            -- proxy URL (masked for display)
  user_agent  text,
  cookies     text,            -- base64-encoded cookie jar
  status      text default 'active' check (status in ('active','expired','flagged','rotating')),
  uses        integer default 0,
  last_used   timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists idx_sessions_project on spp_sessions(project_id);

-- ============================================================
-- 7. RANK TRACKING — SERP position history
-- ============================================================
create table if not exists spp_rank_history (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  keyword     text not null,
  url         text,
  engine      text default 'google' check (engine in ('google','bing','yahoo','duckduckgo')),
  position    integer,         -- null = not in top 100
  page        integer,
  snippet     text,
  checked_at  timestamptz default now()
);
create index if not exists idx_rank_project  on spp_rank_history(project_id);
create index if not exists idx_rank_keyword  on spp_rank_history(keyword);
create index if not exists idx_rank_checked  on spp_rank_history(checked_at desc);

-- ============================================================
-- 8. SETTINGS — per-user/project settings sync (non-sensitive)
-- ============================================================
create table if not exists spp_settings (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  key         text not null,
  value       jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (project_id, key)
);
create index if not exists idx_settings_project on spp_settings(project_id);

-- ============================================================
-- 9. CONTENT LIBRARY — saved generated articles / spin variations
-- ============================================================
create table if not exists spp_content (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  keyword     text,
  title       text,
  body        text,
  format      text default 'markdown' check (format in ('markdown','html','text')),
  tags        text[],
  word_count  integer,
  ai_model    text,            -- which model generated it
  published   boolean default false,
  published_at timestamptz,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists idx_content_project on spp_content(project_id);
create index if not exists idx_content_keyword on spp_content(keyword);

-- ============================================================
-- 10. PING LOG — history of search engine pings
-- ============================================================
create table if not exists spp_ping_log (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references spp_projects(id) on delete cascade,
  url         text not null,
  sitemap     text,
  services    jsonb,           -- array of {service, ok, status, ms}
  success     integer,
  total       integer,
  pinged_at   timestamptz default now()
);
create index if not exists idx_ping_project on spp_ping_log(project_id);
create index if not exists idx_ping_pinged  on spp_ping_log(pinged_at desc);

-- ============================================================
-- UPDATED_AT triggers — auto-update updated_at on every row change
-- ============================================================
create or replace function spp_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Apply trigger to every table with updated_at
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'spp_projects','spp_keywords','spp_links','spp_accounts',
    'spp_jobs','spp_sessions','spp_settings','spp_content'
  ] loop
    execute format(
      'drop trigger if exists trg_%1$s_updated_at on %1$s;
       create trigger trg_%1$s_updated_at
         before update on %1$s
         for each row execute function spp_set_updated_at();',
      tbl
    );
  end loop;
end;
$$;

-- ============================================================
-- ROW LEVEL SECURITY — enable RLS on all tables
-- (users can only see rows belonging to their project)
-- ============================================================
do $$
declare tbl text;
begin
  foreach tbl in array array[
    'spp_projects','spp_keywords','spp_links','spp_accounts',
    'spp_jobs','spp_sessions','spp_rank_history','spp_settings',
    'spp_content','spp_ping_log'
  ] loop
    execute format('alter table %I enable row level security;', tbl);
  end loop;
end;
$$;

-- Permissive policies for anon + authenticated (tool uses anon key from browser)
-- In production: add user_id column and scope policies per auth.uid()
-- For now: anon key gets full access (protected by your Vercel API_SECRET_KEY)
create policy if not exists "anon full access" on spp_projects      for all using (true) with check (true);
create policy if not exists "anon full access" on spp_keywords      for all using (true) with check (true);
create policy if not exists "anon full access" on spp_links         for all using (true) with check (true);
create policy if not exists "anon full access" on spp_accounts      for all using (true) with check (true);
create policy if not exists "anon full access" on spp_jobs          for all using (true) with check (true);
create policy if not exists "anon full access" on spp_sessions      for all using (true) with check (true);
create policy if not exists "anon full access" on spp_rank_history  for all using (true) with check (true);
create policy if not exists "anon full access" on spp_settings      for all using (true) with check (true);
create policy if not exists "anon full access" on spp_content       for all using (true) with check (true);
create policy if not exists "anon full access" on spp_ping_log      for all using (true) with check (true);

-- ============================================================
-- DEFAULT PROJECT — creates a "Default" project so the tool
-- works immediately without needing manual project setup
-- ============================================================
insert into spp_projects (id, name, description, color)
values (
  '00000000-0000-0000-0000-000000000001',
  'Default Project',
  'Auto-created default project for SEO Parasite Pro',
  '#003087'
) on conflict (id) do nothing;

-- ============================================================
-- VERIFY — run this to confirm all tables were created
-- ============================================================
select
  table_name,
  pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size
from information_schema.tables
where table_schema = 'public'
  and table_name like 'spp_%'
order by table_name;
