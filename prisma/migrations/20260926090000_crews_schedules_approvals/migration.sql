-- Summaries are fully recomputed by the new shift engine (sync/shiftEngine.js);
-- the old rows were classified by the retired alternation heuristic.
DELETE FROM `dailyattendancesummary`;

-- DropForeignKey
ALTER TABLE `dailyattendancesummary` DROP FOREIGN KEY `DailyAttendanceSummary_rosteredShiftId_fkey`;

-- DropForeignKey
ALTER TABLE `shiftassignment` DROP FOREIGN KEY `ShiftAssignment_casualWorkerId_fkey`;

-- DropForeignKey
ALTER TABLE `shiftassignment` DROP FOREIGN KEY `ShiftAssignment_shiftId_fkey`;


-- CreateIndex (before dropping the old unique index, so the casualWorkerId FK always has an index)
CREATE UNIQUE INDEX `DailyAttendanceSummary_casualWorkerId_date_shiftId_key` ON `DailyAttendanceSummary`(`casualWorkerId`, `date`, `shiftId`);

-- DropIndex
DROP INDEX `DailyAttendanceSummary_casualWorkerId_date_key` ON `dailyattendancesummary`;

-- AlterTable
ALTER TABLE `dailyattendancesummary` DROP COLUMN `rosteredShiftId`,
    ADD COLUMN `approvalCrewId` INTEGER NULL,
    ADD COLUMN `approvalKey` VARCHAR(191) NOT NULL,
    ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `approvedById` INTEGER NULL,
    ADD COLUMN `changedAfterApproval` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `checkInImplied` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `checkOutImplied` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `lateIn` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `pendingValues` JSON NULL,
    ADD COLUMN `punchIds` JSON NULL,
    ADD COLUMN `regularHours` DOUBLE NULL,
    ADD COLUMN `source` VARCHAR(191) NOT NULL DEFAULT 'schedule',
    ADD COLUMN `supervisorComment` TEXT NULL;

-- AlterTable
ALTER TABLE `portaluser` ADD COLUMN `active` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `createdById` INTEGER NULL,
    ADD COLUMN `crewId` INTEGER NULL,
    ADD COLUMN `name` VARCHAR(191) NOT NULL DEFAULT '',
    ADD COLUMN `role` VARCHAR(191) NOT NULL DEFAULT 'hr';

-- AlterTable
ALTER TABLE `shift` ADD COLUMN `earliestCheckIn` VARCHAR(191) NOT NULL DEFAULT '05:00',
    ADD COLUMN `earlyOutGraceMinutes` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `latestCheckOut` VARCHAR(191) NOT NULL DEFAULT '05:00',
    ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `updatedById` INTEGER NULL,
    MODIFY `graceMinutes` INTEGER NOT NULL DEFAULT 30;

-- DropTable
DROP TABLE `shiftassignment`;

-- CreateTable
CREATE TABLE `Crew` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `subcontractorName` VARCHAR(191) NOT NULL DEFAULT 'Subcontractor A',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Crew_subcontractorName_name_key`(`subcontractorName`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrewRotation` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `crewId` INTEGER NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `anchorDate` DATETIME(3) NOT NULL,
    `pattern` VARCHAR(191) NOT NULL DEFAULT 'DDNNOO',
    `note` VARCHAR(191) NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CrewRotation_crewId_effectiveFrom_key`(`crewId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkerSchedule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `casualWorkerId` INTEGER NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `crewId` INTEGER NULL,
    `note` VARCHAR(191) NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `WorkerSchedule_casualWorkerId_effectiveFrom_key`(`casualWorkerId`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShiftException` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `casualWorkerId` INTEGER NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `shifts` VARCHAR(191) NOT NULL,
    `note` VARCHAR(191) NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ShiftException_casualWorkerId_date_key`(`casualWorkerId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ApprovalUnit` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `subcontractorName` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NULL,
    `shiftId` INTEGER NULL,
    `crewId` INTEGER NULL,
    `month` VARCHAR(191) NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `reopenedAt` DATETIME(3) NULL,
    `dueNotifiedAt` DATETIME(3) NULL,
    `escalatedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedById` INTEGER NULL,
    `comment` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ApprovalUnit_key_key`(`key`),
    INDEX `ApprovalUnit_status_dueAt_idx`(`status`, `dueAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Notification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `link` VARCHAR(191) NULL,
    `readAt` DATETIME(3) NULL,
    `emailedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Notification_userId_readAt_idx`(`userId`, `readAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WorkerProfile` (
    `casualWorkerId` INTEGER NOT NULL,
    `suggestedType` VARCHAR(191) NULL,
    `suggestedCrewId` INTEGER NULL,
    `suggestedPattern` VARCHAR(191) NULL,
    `suggestedAnchor` DATETIME(3) NULL,
    `confidence` DOUBLE NOT NULL DEFAULT 0,
    `completeShifts` INTEGER NOT NULL DEFAULT 0,
    `suggestionKey` VARCHAR(191) NULL,
    `dismissedKey` VARCHAR(191) NULL,
    `notifiedKey` VARCHAR(191) NULL,
    `details` JSON NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`casualWorkerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CrewCycleProposal` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `crewId` INTEGER NOT NULL,
    `pattern` VARCHAR(191) NOT NULL,
    `anchorDate` DATETIME(3) NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'open',
    `evidence` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolvedById` INTEGER NULL,
    `resolvedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `DailyAttendanceSummary_approvalKey_idx` ON `DailyAttendanceSummary`(`approvalKey`);

-- CreateIndex
CREATE INDEX `DailyAttendanceSummary_date_idx` ON `DailyAttendanceSummary`(`date`);

-- CreateIndex

-- AddForeignKey
ALTER TABLE `PortalUser` ADD CONSTRAINT `PortalUser_crewId_fkey` FOREIGN KEY (`crewId`) REFERENCES `Crew`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrewRotation` ADD CONSTRAINT `CrewRotation_crewId_fkey` FOREIGN KEY (`crewId`) REFERENCES `Crew`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkerSchedule` ADD CONSTRAINT `WorkerSchedule_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkerSchedule` ADD CONSTRAINT `WorkerSchedule_crewId_fkey` FOREIGN KEY (`crewId`) REFERENCES `Crew`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShiftException` ADD CONSTRAINT `ShiftException_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Notification` ADD CONSTRAINT `Notification_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `PortalUser`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WorkerProfile` ADD CONSTRAINT `WorkerProfile_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CrewCycleProposal` ADD CONSTRAINT `CrewCycleProposal_crewId_fkey` FOREIGN KEY (`crewId`) REFERENCES `Crew`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Shift rules agreed with the business (see README "Shift rules"):
-- Day 08:00-17:00, check-ins from 05:00, late after 08:30, out by 05:00 next day.
-- Night 17:00-08:00, check-ins from 14:00, late after 17:30, out by 12:00 next day.
UPDATE `Shift` SET `graceMinutes` = 30, `earlyOutGraceMinutes` = 0, `earliestCheckIn` = '05:00', `latestCheckOut` = '05:00' WHERE `name` = 'Day';
UPDATE `Shift` SET `graceMinutes` = 30, `earlyOutGraceMinutes` = 0, `earliestCheckIn` = '14:00', `latestCheckOut` = '12:00' WHERE `name` = 'Night';
