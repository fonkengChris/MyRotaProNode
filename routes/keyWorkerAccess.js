const express = require('express');
const router = express.Router();
const KeyWorkerAccessSettings = require('../models/KeyWorkerAccessSettings');
const { requireRole } = require('../middleware/auth');

const { DEFAULTS, FIELD_VALUES } = KeyWorkerAccessSettings;

const payload = (settings) => {
  const values = {};
  for (const field of Object.keys(FIELD_VALUES)) values[field] = settings[field];
  return { settings: values, defaults: DEFAULTS, options: FIELD_VALUES };
};

router.use(requireRole(['admin']));

router.get('/', async (req, res) => {
  try {
    res.json(payload(await KeyWorkerAccessSettings.getSettings()));
  } catch (error) {
    console.error('Get key worker access error:', error);
    res.status(500).json({ error: 'Failed to fetch key worker access' });
  }
});

router.put('/', async (req, res) => {
  try {
    const settings = await KeyWorkerAccessSettings.getSettings();
    for (const field of Object.keys(FIELD_VALUES)) {
      if (req.body[field] !== undefined) settings[field] = req.body[field];
    }
    settings.updated_by = req.user._id;
    await settings.save();
    res.json(payload(settings));
  } catch (error) {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
      return res.status(400).json({ error: 'Invalid key worker access value' });
    }
    console.error('Update key worker access error:', error);
    res.status(500).json({ error: 'Failed to update key worker access' });
  }
});

router.post('/reset', async (req, res) => {
  try {
    res.json(payload(await KeyWorkerAccessSettings.resetToDefaults(req.user._id)));
  } catch (error) {
    console.error('Reset key worker access error:', error);
    res.status(500).json({ error: 'Failed to reset key worker access' });
  }
});

module.exports = router;
