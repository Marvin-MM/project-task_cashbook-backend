-- Approved leave can be cancelled, and the approval still happened.
--
-- The original constraint said reviewed_at is set exactly when the status is
-- APPROVED or REJECTED. That made cancelling approved leave impossible: the
-- status becomes WITHDRAWN while reviewed_at legitimately stays, because the
-- decision is a fact and clearing it would erase who approved it and when.
--
-- The rule that was actually meant: a PENDING request has not been reviewed,
-- and a decided one has. WITHDRAWN sits either side of that line — withdrawn
-- before a decision (null) or cancelled after one (set).

ALTER TABLE "leave_requests"
  DROP CONSTRAINT "leave_requests_decided_consistently";

ALTER TABLE "leave_requests"
  ADD CONSTRAINT "leave_requests_decided_consistently"
    CHECK (
      ("status" = 'PENDING' AND "reviewed_at" IS NULL)
      OR ("status" IN ('APPROVED', 'REJECTED') AND "reviewed_at" IS NOT NULL)
      OR "status" = 'WITHDRAWN'
    );
