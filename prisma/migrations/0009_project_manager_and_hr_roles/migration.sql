-- Two new workspace roles.
--
-- PROJECT_MANAGER runs delivery (projects, tasks, assignment, approvals) and HR
-- runs people operations (attendance, leave, overtime, reports). Neither holds
-- any financial permission: both reach a cashbook only through an explicit
-- cashbook_members row, exactly like a plain MEMBER.
--
-- Ordering matters for readability of the enum but not for correctness —
-- WORKSPACE_PERMISSION_MATRIX is keyed by name, never by ordinal.

ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'PROJECT_MANAGER' AFTER 'SUB_ACCOUNTANT';
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'HR' AFTER 'PROJECT_MANAGER';
