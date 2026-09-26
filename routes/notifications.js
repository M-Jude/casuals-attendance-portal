const express = require('express');
const prisma = require('../prismaClient');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

router.get('/notifications', authenticate, async (req, res) => {
  try {
    const [notifications, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } })
    ]);
    res.json({ notifications, unread });
  } catch (err) {
    console.error('Failed to load notifications:', err);
    res.status(500).json({ error: 'Could not load notifications.' });
  }
});

router.post('/notifications/read-all', authenticate, async (req, res) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to mark notifications read:', err);
    res.status(500).json({ error: 'Could not update notifications.' });
  }
});

router.post('/notifications/:id/read', authenticate, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { id: parseInt(req.params.id, 10), userId: req.user.id, readAt: null },
      data: { readAt: new Date() }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to mark notification read:', err);
    res.status(500).json({ error: 'Could not update the notification.' });
  }
});

module.exports = router;
