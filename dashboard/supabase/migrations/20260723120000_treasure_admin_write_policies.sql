-- Allow NavMe Dashboard (anon key) to CRUD treasure content tables.
-- Applied remotely as treasure_admin_write_policies.

grant select, insert, update, delete on public.treasure_levels to anon, authenticated;
grant select, insert, update, delete on public.treasure_items to anon, authenticated;
grant select, insert, update, delete on public.treasure_tasks to anon, authenticated;
grant select, insert, update, delete on public.treasure_task_tokens to anon, authenticated;
grant select, insert, update, delete on public.treasure_cheats to anon, authenticated;
grant select, insert, update, delete on public.treasure_players to anon, authenticated;
grant select, insert, update, delete on public.treasure_player_progress to anon, authenticated;
grant select, insert, update, delete on public.treasure_collections to anon, authenticated;

drop policy if exists treasure_levels_read on public.treasure_levels;
drop policy if exists treasure_levels_all on public.treasure_levels;
create policy treasure_levels_all on public.treasure_levels
  for all to anon, authenticated using (true) with check (true);

drop policy if exists treasure_items_read on public.treasure_items;
drop policy if exists treasure_items_all on public.treasure_items;
create policy treasure_items_all on public.treasure_items
  for all to anon, authenticated using (true) with check (true);

drop policy if exists treasure_tasks_read on public.treasure_tasks;
drop policy if exists treasure_tasks_all on public.treasure_tasks;
create policy treasure_tasks_all on public.treasure_tasks
  for all to anon, authenticated using (true) with check (true);

drop policy if exists treasure_task_tokens_read on public.treasure_task_tokens;
drop policy if exists treasure_task_tokens_all on public.treasure_task_tokens;
create policy treasure_task_tokens_all on public.treasure_task_tokens
  for all to anon, authenticated using (true) with check (true);

drop policy if exists treasure_cheats_read on public.treasure_cheats;
drop policy if exists treasure_cheats_all on public.treasure_cheats;
create policy treasure_cheats_all on public.treasure_cheats
  for all to anon, authenticated using (true) with check (true);
