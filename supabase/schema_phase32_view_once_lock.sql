-- Veltrix · phase 32: lock one-time (view once) photos/videos sent between real users. Safe to run more than once.
-- Run in: Supabase Dashboard → SQL Editor → New query → Run (after phase 31)
-- When the receiver closes a one-time photo/video the pointer to the sender's file is removed from their copy of the
-- message, so the storage rule from phase 31 no longer lets them read it again (not even by tampering with the app).
create or replace function public.chat_media_consume(p_msg text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then return false; end if;
  update public.messages
     set data = (data - 'mediaOwner' - 'mediaId') || jsonb_build_object('opened', true)
   where id = p_msg and user_id = auth.uid()
     and data ? 'mediaOwner' and coalesce((data->>'once')::boolean, false);
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke execute on function public.chat_media_consume(text) from public, anon;
grant  execute on function public.chat_media_consume(text) to authenticated;
