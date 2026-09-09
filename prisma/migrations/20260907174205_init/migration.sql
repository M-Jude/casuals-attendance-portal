-- CreateTable
CREATE TABLE `CasualWorker` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `biostarUserId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `subcontractorName` VARCHAR(191) NOT NULL DEFAULT 'Subcontractor A',
    `startDate` DATETIME(3) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',

    UNIQUE INDEX `CasualWorker_biostarUserId_key`(`biostarUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `casualWorkerId` INTEGER NOT NULL,
    `biostarEventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `rawPayload` JSON NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AttendanceLog_biostarEventId_key`(`biostarEventId`),
    INDEX `AttendanceLog_casualWorkerId_timestamp_idx`(`casualWorkerId`, `timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PortalUser` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `subcontractorName` VARCHAR(191) NOT NULL DEFAULT 'Subcontractor A',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PortalUser_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AttendanceLog` ADD CONSTRAINT `AttendanceLog_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
