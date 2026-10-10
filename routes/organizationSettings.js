const express = require('express');
const router = express.Router();
const OrganizationSettings = require('../models/OrganizationSettings');
const { authenticateToken, requireRole } = require('../middleware/auth');

// Get company-wide settings (help/emergency contacts, shift tips, key-worker prompts).
// Available to every authenticated user — staff need these on their profile.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const settings = await OrganizationSettings.getSettings();
    res.json(settings);
  } catch (error) {
    console.error('Get organization settings error:', error);
    res.status(500).json({ error: 'Failed to fetch organization settings' });
  }
});

// Update company-wide settings. Admin only.
router.put('/', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const settings = await OrganizationSettings.getSettings();

    const { company_contacts, emergency_contacts, shift_tips, key_worker_tasks } = req.body;
    if (Array.isArray(company_contacts)) settings.company_contacts = company_contacts;
    if (Array.isArray(emergency_contacts)) settings.emergency_contacts = emergency_contacts;
    if (shift_tips && typeof shift_tips === 'object') {
      settings.shift_tips = {
        core: Array.isArray(shift_tips.core) ? shift_tips.core : settings.shift_tips.core,
        day: Array.isArray(shift_tips.day) ? shift_tips.day : settings.shift_tips.day,
        night: Array.isArray(shift_tips.night) ? shift_tips.night : settings.shift_tips.night,
        escalation: Array.isArray(shift_tips.escalation) ? shift_tips.escalation : settings.shift_tips.escalation
      };
    }
    if (key_worker_tasks && typeof key_worker_tasks === 'object') {
      settings.key_worker_tasks = {
        daily: Array.isArray(key_worker_tasks.daily) ? key_worker_tasks.daily : settings.key_worker_tasks.daily,
        weekly: Array.isArray(key_worker_tasks.weekly) ? key_worker_tasks.weekly : settings.key_worker_tasks.weekly,
        monthly: Array.isArray(key_worker_tasks.monthly) ? key_worker_tasks.monthly : settings.key_worker_tasks.monthly
      };
    }
    settings.updated_by = req.user._id;

    await settings.save();
    res.json(settings);
  } catch (error) {
    console.error('Update organization settings error:', error);
    res.status(400).json({ error: 'Failed to update organization settings', details: error.message });
  }
});

module.exports = router;
