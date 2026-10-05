-- Enable Supabase Realtime (websocket) for NavMe editor tables.
-- Run in Supabase Dashboard → SQL Editor if MCP/CLI is unavailable.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'navme_media'
  ) then
    alter publication supabase_realtime add table public.navme_media;
  end if;

  if to_regclass('public.navme_poi') is not null and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'navme_poi'
  ) then
    alter publication supabase_realtime add table public.navme_poi;
  end if;

  if to_regclass('public.navme_facilities') is not null and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'navme_facilities'
  ) then
    alter publication supabase_realtime add table public.navme_facilities;
  end if;

  if to_regclass('public.navme_blocks') is not null and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'navme_blocks'
  ) then
    alter publication supabase_realtime add table public.navme_blocks;
  end if;

  if to_regclass('public.navme_categories') is not null and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'navme_categories'
  ) then
    alter publication supabase_realtime add table public.navme_categories;
  end if;
end $$;

alter table if exists public.navme_media replica identity full;
alter table if exists public.navme_poi replica identity full;
alter table if exists public.navme_facilities replica identity full;
alter table if exists public.navme_blocks replica identity full;
alter table if exists public.navme_categories replica identity full;
