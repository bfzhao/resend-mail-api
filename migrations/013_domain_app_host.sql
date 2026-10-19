-- Optional hostname the app is served on (mail.example.com), set by the setup wizard's "访问域名" option.
-- NULL = the deployment keeps using its workers.dev URL.
ALTER TABLE domains ADD COLUMN app_host TEXT;
