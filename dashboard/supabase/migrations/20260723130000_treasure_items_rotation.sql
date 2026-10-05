-- Rotation for treasure images / tokens (dashboard + AR).

alter table public.treasure_items
  add column if not exists rot_x double precision not null default 0,
  add column if not exists rot_y double precision not null default 0,
  add column if not exists rot_z double precision not null default 0;

alter table public.treasure_task_tokens
  add column if not exists rot_x double precision not null default 0,
  add column if not exists rot_y double precision not null default 0,
  add column if not exists rot_z double precision not null default 0;
