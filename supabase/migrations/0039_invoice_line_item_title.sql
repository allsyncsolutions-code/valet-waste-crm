-- 0039: optional title for invoice line items, shown bold above the
-- description in the editor, invoice preview, PayPage, and email.
alter table invoice_line_items add column if not exists title text;
