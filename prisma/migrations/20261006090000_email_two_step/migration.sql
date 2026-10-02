-- Email codes as a second two-step sign-in method (and a fallback for
-- authenticator-app users).
ALTER TABLE `PortalUser`
  ADD COLUMN `mfaMethod` VARCHAR(191) NULL,
  ADD COLUMN `mfaEmailCodeHash` VARCHAR(191) NULL,
  ADD COLUMN `mfaEmailCodeExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `mfaEmailCodeSentAt` DATETIME(3) NULL,
  ADD COLUMN `mfaEmailCodeAttempts` INTEGER NOT NULL DEFAULT 0;

-- Everyone already set up used the authenticator app.
UPDATE `PortalUser` SET `mfaMethod` = 'app' WHERE `mfaEnabledAt` IS NOT NULL;
