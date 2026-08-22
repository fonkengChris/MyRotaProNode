const express = require('express');
const router = express.Router();
const Service = require('../models/Service');
const { requireRole, getUserHomeIds } = require('../middleware/auth');

// Get all services (admins see all; everyone else only services in their home(s))
router.get('/', async (req, res) => {
  try {
    const { home_id } = req.query;
    const filter = {};

    // Only filter by home_id if it's provided and valid
    if (home_id && home_id !== 'undefined' && home_id !== 'null') {
      // Non-admins may only query a home they belong to.
      if (req.user.role !== 'admin' && !getUserHomeIds(req.user).includes(home_id.toString())) {
        return res.status(403).json({ error: 'Access denied. You can only view services for your own home.' });
      }
      // Use $in to check if the home_id is in the home_ids array
      filter.home_ids = { $in: [home_id] };
    } else if (req.user.role !== 'admin') {
      // No explicit home requested: restrict to the user's own home(s).
      filter.home_ids = { $in: getUserHomeIds(req.user) };
    }

    // Always populate home_ids with full home details for frontend filtering
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

    // Non-admins can only view a service offered in one of their homes.
    if (req.user.role !== 'admin') {
      const myHomeIds = getUserHomeIds(req.user);
      const serviceHomeIds = (service.home_ids || []).map(h => (h && h._id ? h._id : h).toString());
      if (!serviceHomeIds.some(id => myHomeIds.includes(id))) {
        return res.status(403).json({ error: 'Access denied. You can only view services for your own home.' });
      }
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
    res.status(400).json({ error: 'Failed to update service', details: error.message });
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
