require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { syncAttendance } = require('./sync/attendanceSync');

const app = express();
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/attendance')); // GET /api/attendance

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Casuals attendance portal API listening on port ${PORT}`);
});

// Sync BioStar attendance data hourly, plus once on startup so data isn't
// stale until the first scheduled tick.
cron.schedule('0 * * * *', () => {
  syncAttendance().catch((err) => console.error('Scheduled sync failed:', err));
});
syncAttendance().catch((err) => console.error('Initial sync failed:', err));
