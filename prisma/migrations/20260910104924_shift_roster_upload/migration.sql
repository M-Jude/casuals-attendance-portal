-- AlterTable
ALTER TABLE `dailyattendancesummary` ADD COLUMN `earlyCheckOut` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `rosteredShiftId` INTEGER NULL;

-- AlterTable
ALTER TABLE `shiftassignment` ADD COLUMN `uploadedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- AddForeignKey
ALTER TABLE `DailyAttendanceSummary` ADD CONSTRAINT `DailyAttendanceSummary_rosteredShiftId_fkey` FOREIGN KEY (`rosteredShiftId`) REFERENCES `Shift`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
