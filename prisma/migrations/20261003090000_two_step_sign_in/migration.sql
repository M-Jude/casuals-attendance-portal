-- Two-step sign-in (authenticator-app codes) for System Admins.
ALTER TABLE `PortalUser`
  ADD COLUMN `mfaSecret` VARCHAR(191) NULL,
  ADD COLUMN `mfaPendingSecret` VARCHAR(191) NULL,
  ADD COLUMN `mfaEnabledAt` DATETIME(3) NULL,
  ADD COLUMN `mfaLastStep` INTEGER NULL;
