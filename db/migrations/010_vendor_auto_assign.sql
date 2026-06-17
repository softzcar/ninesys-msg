-- 010_vendor_auto_assign.sql
-- Switch de auto-asignación por vendedor individual (Option C)

ALTER TABLE wa_vendor_state ADD COLUMN allow_auto_assign TINYINT(1) NOT NULL DEFAULT 1;
