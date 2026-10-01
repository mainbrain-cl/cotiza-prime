-- Deshace 20261001120400_legal.sql
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.accept_current_legal_documents();
drop function if exists app.handle_new_user();
drop table if exists public.legal_acceptances;
drop table if exists public.legal_documents;
