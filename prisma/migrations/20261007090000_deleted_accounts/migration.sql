-- System Admins can delete portal accounts; the name of each deleted account
-- is kept so approvals and reports still say who approved what.
CREATE TABLE `DeletedAccount` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `subcontractorName` VARCHAR(191) NOT NULL,
    `accountCreatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedById` INTEGER NULL,

    INDEX `DeletedAccount_accountId_idx`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
