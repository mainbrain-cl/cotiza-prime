-- Deshace 20261001130000_legal_documents_seed.sql
-- Las aceptaciones dependen de los documentos: se quitan primero (solo tiene sentido en pruebas).
delete from public.legal_acceptances
  where document_id in (select id from public.legal_documents where version = '2026-10-01-preliminar');
delete from public.legal_documents where version = '2026-10-01-preliminar';
