-- The general manager role.
--
-- One new role rather than the handful the org chart suggests (attendant,
-- maintenance, social media, supervisor). Those are JOBS, not authority: every
-- one of them holds exactly MEMBER's permissions, so they are carried by
-- workspace_members.staff_tag in the next migration instead of by five matrix
-- entries that differ only in their name.
--
-- A general manager reaches as far into the books as an admin, but deliberately
-- cannot change what the organisation is or what its books mean: no workspace
-- rename or delete, no chart-of-accounts edits, no period close, no manual
-- journal, no member import, and no appointing accountants.
--
-- Ordering is for readability only — WORKSPACE_PERMISSION_MATRIX is keyed by
-- name, never by ordinal.

ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'GENERAL_MANAGER' AFTER 'ADMIN';
