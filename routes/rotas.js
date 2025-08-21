const express = require('express');
const router = express.Router();
const Rota = require('../models/Rota');
const { requireRole } = require('../middleware/auth');

// Get all rotas
router.get('/', async (req, res) => {
  try {
    const { home_id, service_id, status, week_start_date, week_end_date } = req.query;
    const filter = {};
    
    if (home_id) filter.home_id = home_id;
    if (service_id) filter.service_id = service_id;
    if (status) filter.status = status;
    if (week_start_date || week_end_date) {
      filter.week_start_date = {};
      if (week_start_date) filter.week_start_date.$gte = week_start_date;
      if (week_end_date) filter.week_start_date.$lte = week_end_date;
    }
    
    const rotas = await Rota.find(filter)
      .populate('home_id', 'name')
      .populate('service_id', 'name')
      .populate('created_by', 'name');
    
    res.json(rotas);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rotas' });
  }
});

// Get rota by ID
router.get('/:id', async (req, res) => {
  try {
    const rota = await Rota.findById(req.params.id)
      .populate('home_id', 'name')
      .populate('service_id', 'name')
      .populate('created_by', 'name');
    
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }
    
    res.json(rota);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rota' });
  }
});

// Create new rota
router.post('/', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const rota = new Rota(req.body);
    await rota.save();
    res.status(201).json(rota);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create rota' });
  }
});

// Update rota
router.put('/:id', requireRole(['admin', 'home_manager', 'senior_staff']), async (req, res) => {
  try {
    const rota = await Rota.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }
    
    res.json(rota);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update rota' });
  }
});

// Delete rota
router.delete('/:id', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const rota = await Rota.findByIdAndDelete(req.params.id);
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }
    res.json({ message: 'Rota deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete rota' });
  }
});

// Publish rota
router.post('/:id/publish', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const rota = await Rota.findById(req.params.id);
    
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }
    
    await rota.publish();
    res.json(rota);
  } catch (error) {
    res.status(400).json({ error: 'Failed to publish rota' });
  }
});

// Archive rota
router.post('/:id/archive', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const rota = await Rota.findById(req.params.id);
    
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }
    
    await rota.archive();
    res.json(rota);
  } catch (error) {
    res.status(400).json({ error: 'Failed to archive rota' });
  }
});

// Revert rota to draft
router.post('/:id/revert', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const rota = await Rota.findById(req.params.id);
    
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }
    
    await rota.revertToDraft();
    res.json(rota);
  } catch (error) {
    res.status(400).json({ error: 'Failed to revert rota' });
  }
});

module.exports = router;
