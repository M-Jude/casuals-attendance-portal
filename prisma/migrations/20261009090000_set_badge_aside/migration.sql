-- A badge made by mistake can be set aside: kept and shown, but left out of
-- every shift calculation.
ALTER TABLE `AttendanceLog`
  ADD COLUMN `setAsideAt` DATETIME(3) NULL,
  ADD COLUMN `setAsideById` INTEGER NULL,
  ADD COLUMN `setAsideReason` TEXT NULL;
