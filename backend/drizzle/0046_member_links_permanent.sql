-- o link de acesso da área de membros passa a valer sempre (é o único jeito de entrar)
UPDATE "member_tokens" SET "expires_at" = now() + interval '10 years' WHERE "expires_at" < now() + interval '1 year';
