-- Veltrix · phase 16: send videos up to 500 MB in Messages.
-- Run in the Supabase SQL Editor.
-- IMPORTANT: this raises the limit of the chat-media bucket, but Supabase also has a PROJECT-WIDE upload limit
-- (Dashboard → Storage → Settings → "Global file size limit"). The free plan caps that at 50 MB; a paid plan lets you raise it.
-- Set it to at least 500 MB there, otherwise uploads over the project limit are refused no matter what this script does.
update storage.buckets set file_size_limit = 524288000 where id = 'chat-media';   -- 500 MB
