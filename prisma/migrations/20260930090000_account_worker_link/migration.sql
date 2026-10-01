-- Links a portal account to the account holder's worker record.
ALTER TABLE `PortalUser` ADD COLUMN `casualWorkerId` INTEGER NULL;

CREATE UNIQUE INDEX `PortalUser_casualWorkerId_key` ON `PortalUser`(`casualWorkerId`);

ALTER TABLE `PortalUser` ADD CONSTRAINT `PortalUser_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
