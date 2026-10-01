-- Migración 9 — Versiones vigentes de términos y privacidad
-- Versión y huella SHA-256 salen de src/lib/legal/documents.ts (textos en src/content/legal/).
-- Si cambia un texto, hay que publicar una versión nueva con otra migración: la prueba
-- tests/db/legal-seed.test.ts falla si la huella del código y la de la base no coinciden.
-- Entorno: PRUEBAS (Supabase local). Deshacer: supabase/rollbacks/20261001130000_legal_documents_seed.down.sql

insert into public.legal_documents (kind, version, content_sha256, published_at, is_current) values
  ('terms',   '2026-10-01-preliminar', 'ac1349f90c885d9c89581d082681512dd65c12d4b20d43fde08ac89a52858ac6', '2026-10-01 00:00:00-03', true),
  ('privacy', '2026-10-01-preliminar', 'ec041a831e58d9b4e2ad2b24bd89fd4ba1cf2ca00107cea4c5ce3624ea86f10a', '2026-10-01 00:00:00-03', true);
