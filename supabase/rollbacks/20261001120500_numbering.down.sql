-- Deshace 20261001120500_numbering.sql
drop function if exists public.preview_next_quote_number();
drop function if exists public.set_numbering(text, text, bigint);
drop function if exists app.allocate_quote_number(uuid);
drop function if exists app.current_business_year();
drop function if exists app.format_quote_number(text, text, integer, integer, bigint);
drop function if exists app.numbering_scope(text, integer);
drop table if exists public.numbering_sequences;
drop table if exists public.numbering_settings;
drop function if exists app.forbid_sequence_decrease();
