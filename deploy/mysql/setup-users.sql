-- One-time: give the portal its own MySQL users instead of root.
-- Run as root (e.g. in MySQL Workbench, or: mysql -u root -p -P 4436 < setup-users.sql)
-- after replacing the two passwords below. Then follow "Database users" in
-- the README to switch the portal over.
--
--   casuals_migrate  used only by the deploy: applies migrations and keeps
--                    casuals_app's table permissions up to date.
--   casuals_app      used by the running portal. Gets NO database-wide
--                    rights here — scripts/dbGrants.js grants them table by
--                    table, read + add only on the audit log.
--
-- Both are created for 'localhost' and '127.0.0.1', which covers how the
-- portal connects to a database on the same server.
--
-- Passwords: use long random ones of letters and digits only, so they need
-- no escaping in the connection URLs. To make one:
--   node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

CREATE USER IF NOT EXISTS 'casuals_migrate'@'localhost' IDENTIFIED BY 'REPLACE_WITH_MIGRATE_PASSWORD';
CREATE USER IF NOT EXISTS 'casuals_migrate'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_MIGRATE_PASSWORD';
GRANT ALL PRIVILEGES ON `casuals_portal`.* TO 'casuals_migrate'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON `casuals_portal`.* TO 'casuals_migrate'@'127.0.0.1' WITH GRANT OPTION;

CREATE USER IF NOT EXISTS 'casuals_app'@'localhost' IDENTIFIED BY 'REPLACE_WITH_APP_PASSWORD';
CREATE USER IF NOT EXISTS 'casuals_app'@'127.0.0.1' IDENTIFIED BY 'REPLACE_WITH_APP_PASSWORD';

FLUSH PRIVILEGES;
