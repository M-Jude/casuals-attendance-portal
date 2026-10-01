-- Audit trail: who did what, when, from which IP address and device.
CREATE TABLE `AuditLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userId` INTEGER NULL,
    `userEmail` VARCHAR(191) NULL,
    `userName` VARCHAR(191) NULL,
    `userRole` VARCHAR(191) NULL,
    `subcontractorName` VARCHAR(191) NULL,
    `category` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `summary` TEXT NOT NULL,
    `entityType` VARCHAR(191) NULL,
    `entityId` VARCHAR(191) NULL,
    `success` BOOLEAN NOT NULL DEFAULT true,
    `statusCode` INTEGER NULL,
    `method` VARCHAR(10) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` TEXT NULL,
    `device` VARCHAR(191) NULL,
    `details` JSON NULL,

    INDEX `AuditLog_createdAt_idx`(`createdAt`),
    INDEX `AuditLog_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `AuditLog_category_createdAt_idx`(`category`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
