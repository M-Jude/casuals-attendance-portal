-- Accounts whose password was set by someone else must change it at their
-- next sign-in. Existing accounts are left as they are.
ALTER TABLE `PortalUser` ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false;
