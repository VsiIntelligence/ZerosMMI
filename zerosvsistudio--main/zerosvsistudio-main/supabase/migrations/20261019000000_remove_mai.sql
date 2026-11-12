-- Removes the table that belonged to the retired MAI feature (its index and access rules go with it).
--
-- WARNING: this permanently deletes every message stored in that table. Run it only once you are sure you
-- no longer need that history. Zeros itself no longer reads or writes this table, so skipping this file is harmless.
drop table if exists public.mai_messages cascade;
