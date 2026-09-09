-- CreateTable
CREATE TABLE `Shift` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `graceMinutes` INTEGER NOT NULL DEFAULT 15,

    UNIQUE INDEX `Shift_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShiftAssignment` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `casualWorkerId` INTEGER NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `shiftId` INTEGER NOT NULL,

    UNIQUE INDEX `ShiftAssignment_casualWorkerId_date_key`(`casualWorkerId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DailyAttendanceSummary` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `casualWorkerId` INTEGER NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `shiftId` INTEGER NOT NULL,
    `checkIn` DATETIME(3) NULL,
    `checkOut` DATETIME(3) NULL,
    `hoursWorked` DOUBLE NULL,
    `status` VARCHAR(191) NOT NULL,
    `hasMultiplePunches` BOOLEAN NOT NULL DEFAULT false,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DailyAttendanceSummary_casualWorkerId_date_key`(`casualWorkerId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ShiftAssignment` ADD CONSTRAINT `ShiftAssignment_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShiftAssignment` ADD CONSTRAINT `ShiftAssignment_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `Shift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DailyAttendanceSummary` ADD CONSTRAINT `DailyAttendanceSummary_casualWorkerId_fkey` FOREIGN KEY (`casualWorkerId`) REFERENCES `CasualWorker`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DailyAttendanceSummary` ADD CONSTRAINT `DailyAttendanceSummary_shiftId_fkey` FOREIGN KEY (`shiftId`) REFERENCES `Shift`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
