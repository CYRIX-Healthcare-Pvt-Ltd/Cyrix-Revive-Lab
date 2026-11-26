/*
  rl_0068 — Revive Lab's files no longer hold database connections for seconds (the user, 12 Nov: the live database kept
  hitting its 60-connection limit; "Revive Lab file listings on revive-attachments taking 20–90 s each").

  Measured as a regular user, before: one ticket's file list (storage.search) 13.1 s, one file by its exact name 10 s.
  The storage rules are checked on every file in the bucket (2,391) before the folder is narrowed down, and each check
    · found the ticket by turning every ticket id into text (no index: a search of all tickets, per file), and
    · for reading, ran revive_can_see — every rule, about 4 ms — per file.
  storage.search had run 19,981 times at 7.4 s on average.

  Now:
    · reading: who can see which tickets is worked out once per look-up (revive_visible_ids, the Tickets list's own,
      rl_0067) and each file's folder is checked against that list;
    · uploading, replacing, deleting: the ticket or request is found by its id (the index), the same rules after it.
  Who may see, add, replace or remove a file is unchanged: the rules are the same, only how the row is found.
*/

-- The id in a file's folder, or null when that part is not an id ('requests', 'parts').
create or replace function public.revive_folder_id(p_name text, p_pos int)
returns uuid language sql immutable parallel safe set search_path to 'public' as $$
  select case when (storage.foldername(p_name))[p_pos] ~* '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$'
              then ((storage.foldername(p_name))[p_pos])::uuid end
$$;
revoke all on function public.revive_folder_id(text, int) from public, anon;
grant execute on function public.revive_folder_id(text, int) to authenticated;

-- Reading a ticket's files: the tickets the person can see, once (a sub-select is worked out once per statement).
drop policy if exists revive_attachments_read on storage.objects;
create policy revive_attachments_read on storage.objects for select to authenticated
  using (bucket_id = 'revive-attachments'
         and (storage.foldername(name))[1] in (select v::text from unnest(public.revive_visible_ids()) v));

-- The other rules: the same conditions, the ticket or request found by its id instead of by text.
do $$
declare p record; q text; c text; sql text;
begin
  for p in
    select policyname, qual, with_check from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('revive_attachments_delete', 'revive_attachments_insert', 'revive_attachments_update',
                         'revive_parts_insert', 'revive_parts_update',
                         'revive_stock_parts_insert', 'revive_stock_parts_read', 'revive_stock_parts_update')
  loop
    q := p.qual; c := p.with_check;
    q := replace(q, '(t.id)::text = (storage.foldername(objects.name))[1]', 't.id = public.revive_folder_id(objects.name, 1)');
    c := replace(c, '(t.id)::text = (storage.foldername(objects.name))[1]', 't.id = public.revive_folder_id(objects.name, 1)');
    q := replace(q, '(r.ticket_id)::text = (storage.foldername(objects.name))[1]', 'r.ticket_id = public.revive_folder_id(objects.name, 1)');
    c := replace(c, '(r.ticket_id)::text = (storage.foldername(objects.name))[1]', 'r.ticket_id = public.revive_folder_id(objects.name, 1)');
    q := replace(q, '(r.id)::text = (storage.foldername(objects.name))[3]', 'r.id = public.revive_folder_id(objects.name, 3)');
    c := replace(c, '(r.id)::text = (storage.foldername(objects.name))[3]', 'r.id = public.revive_folder_id(objects.name, 3)');
    q := replace(q, '(r.id)::text = (storage.foldername(objects.name))[2]', 'r.id = public.revive_folder_id(objects.name, 2)');
    c := replace(c, '(r.id)::text = (storage.foldername(objects.name))[2]', 'r.id = public.revive_folder_id(objects.name, 2)');
    sql := format('alter policy %I on storage.objects', p.policyname);
    if q is not null then sql := sql || format(' using (%s)', q); end if;
    if c is not null then sql := sql || format(' with check (%s)', c); end if;
    if position('::text = (storage.foldername' in coalesce(q, '') || coalesce(c, '')) > 0 then
      raise exception 'rl_0068: % still finds its row by text', p.policyname;
    end if;
    execute sql;
  end loop;
end $$;
