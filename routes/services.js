const express = require('express');
const router = express.Router();
const Service = require('../models/Service');
const { requireRole } = require('../middleware/auth');

// Get all services
router.get('/', async (req, res) => {
  try {
    const { home_id } = req.query;
    const filter = {};
    
    // Only filter by home_id if it's provided and valid
    if (home_id && home_id !== 'undefined' && home_id !== 'null') {
      filter.home_ids = home_id;
    }
    
    const services = await Service.find(filter).populate('home_ids', 'name location.city');
    res.json(services);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// Get service by ID
router.get('/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id).populate('home_ids', 'name location.city');
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json(service);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

// Create new service
router.post('/', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const service = new Service(req.body);
    await service.save();
    res.status(201).json(service);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create service' });
  }
});

// Update service
router.put('/:id', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    
    res.json(service);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update service' });
  }
});

// Delete service
router.delete('/:id', requireRole(['admin', 'home_manager']), async (req, res) => {
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

module.exports = router;
