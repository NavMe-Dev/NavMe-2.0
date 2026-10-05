-- Billboard title for per-treasure hints (description stays in `hint`).

alter table public.treasure_items
  add column if not exists hint_title text;
