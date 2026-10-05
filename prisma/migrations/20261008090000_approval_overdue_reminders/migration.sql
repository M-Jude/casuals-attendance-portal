-- Email reminders for approval batches still unapproved 24 hours after they
-- became approvable, repeated every 24 hours until approved.
ALTER TABLE `ApprovalUnit` ADD COLUMN `overdueRemindedAt` DATETIME(3) NULL;
