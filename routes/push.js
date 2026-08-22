const express = require('express');
const router = express.Router();
const PushSubscription = require('../models/PushSubscription');
const { getConfig } = require('../config/env');

// Public VAPID key the frontend needs to create a subscription.
router.get('/vapid-public-key', (req, res) => {
  const push = getConfig().push || {};
  const key = push.publicKey;
  if (!key) {
    return res.status(503).json({ error: 'Push notifications are not configured' });
  }
  res.json({ publicKey: key });
});

// Save (or refresh) the caller's push subscription for this device.
router.post('/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }

    // Upsert by endpoint so re-subscribing on the same device updates ownership/keys.
    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        user_id: req.user._id,
        endpoint,
        keys,
        user_agent: req.get('user-agent'),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Remove a subscription (e.g. user disables notifications).
router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
    await PushSubscription.deleteOne({ endpoint, user_id: req.user._id });
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

module.exports = router;
