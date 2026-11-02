const express = require('express');
const router = express.Router();
const Rota = require('../models/Rota');
const Shift = require('../models/Shift');
const { requireRole, requireAccess, canReachHome, keyWorkerOutOfScope, reachesAllHomes, getUserHomeIds } = require('../middleware/auth');
const { queueForAssignees } = require('../services/shiftChangeNotifications');
const mongoose = require('mongoose');

// Fields PUT may set: never the home, and never `$` operators.
const EDITABLE_ROTA_FIELDS = ['service_id', 'week_start_date', 'week_end_date', 'status', 'shifts', 'total_hours', 'total_shifts', 'notes'];

function pickRotaFields(body) {
  const data = {};
  for (const field of EDITABLE_ROTA_FIELDS) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  return data;
}

// Blocks key workers from a rota whose home is outside their scope.
async function checkRotaHome(req, res, next) {
  try {
    if (req.user.role !== 'key_worker') return next();
    const rota = await Rota.findById(req.params.id).select('home_id');
    if (rota && keyWorkerOutOfScope(req.user, 'rota', rota.home_id)) {
      return res.status(403).json({ error: 'Access denied. You can only manage rotas for your own home.' });
    }
    next();
  } catch (error) {
    res.status(400).json({ error: 'Invalid rota' });
  }
}

function toYyyyMmDd(date) {
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

// Get all rotas
router.get('/', async (req, res) => {
  try {
    const { home_id, service_id, status, week_start_date, week_end_date } = req.query;
    const filter = {};
    
    // Guard against `home_id=null` coming from the client. Mongoose would throw a CastError otherwise.
    if (home_id === 'null' || home_id === 'undefined') {
      return res.status(400).json({ error: 'Valid home_id is required' });
    }
    if (home_id && !mongoose.Types.ObjectId.isValid(home_id)) {
      return res.status(400).json({ error: 'Invalid home_id' });
    }
    if (home_id) {
      filter.home_id = home_id;
    }
    if (service_id) filter.service_id = service_id;
    if (status) filter.status = status;
    if (week_start_date || week_end_date) {
      filter.week_start_date = {};
      if (week_start_date) filter.week_start_date.$gte = week_start_date;
      if (week_end_date) filter.week_start_date.$lte = week_end_date;
    }

    // Non-admins can only see rotas for their own home(s).
    if (req.user.role !== 'admin') {
      if (home_id) {
        if (!canReachHome(req.user, 'rota', home_id)) {
          return res.status(403).json({ error: 'Access denied. You can only view rotas for your own home.' });
        }
      } else if (!reachesAllHomes(req.user, 'rota')) {
        filter.home_id = { $in: getUserHomeIds(req.user) };
      }
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

    // Non-admins can only view rotas for a home they belong to.
    if (req.user.role !== 'admin') {
      const rotaHomeId = (rota.home_id && rota.home_id._id ? rota.home_id._id : rota.home_id);
      if (!rotaHomeId || !canReachHome(req.user, 'rota', rotaHomeId)) {
        return res.status(403).json({ error: 'Access denied. You can only view rotas for your own home.' });
      }
    }

    res.json(rota);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rota' });
  }
});

// Create new rota (managers only, scoped to their home)
router.post('/', requireRole(['admin', 'key_worker']), requireAccess('rota'), async (req, res) => {
  try {
    if (keyWorkerOutOfScope(req.user, 'rota', req.body.home_id)) {
      return res.status(403).json({ error: 'Access denied. You can only create rotas for your own home.' });
    }
    const rota = new Rota(req.body);
    await rota.save();
    res.status(201).json(rota);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create rota' });
  }
});

// Update rota (managers only, scoped to their home)
router.put('/:id', requireRole(['admin', 'key_worker']), requireAccess('rota'), checkRotaHome, async (req, res) => {
  try {
    const rota = await Rota.findByIdAndUpdate(
      req.params.id,
      pickRotaFields(req.body),
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
router.delete('/:id', requireRole(['admin', 'key_worker']), requireAccess('rota'), checkRotaHome, async (req, res) => {
  try {
    const rota = await Rota.findById(req.params.id).select('shifts home_id service_id week_start_date week_end_date status');
    if (!rota) {
      return res.status(404).json({ error: 'Rota not found' });
    }

    // Unassign staff from all shifts linked to this rota before deleting it.
    // Fallback to week+home+service lookup when explicit shift refs are missing.
    const referencedShiftIds = (rota.shifts || []).filter(id => mongoose.Types.ObjectId.isValid(id));
    let unassignFilter;

    if (referencedShiftIds.length > 0) {
      unassignFilter = { _id: { $in: referencedShiftIds } };
    } else {
      unassignFilter = {
        home_id: rota.home_id,
        service_id: rota.service_id,
        date: {
          $gte: toYyyyMmDd(rota.week_start_date),
          $lte: toYyyyMmDd(rota.week_end_date)
        }
      };
    }

    const shiftsToUnassign = await Shift.find(unassignFilter).lean();
    const unassignResult = await Shift.updateMany(
      unassignFilter,
      { $set: { assigned_staff: [] } }
    );
    queueForAssignees(req.user._id, shiftsToUnassign, 'removed');

    await Rota.findByIdAndDelete(req.params.id);

    res.json({
      message: 'Rota deleted and shift assignments cleared successfully',
      shifts_unassigned: unassignResult.modifiedCount || 0
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete rota' });
  }
});

// Publish rota
router.post('/:id/publish', requireRole(['admin', 'key_worker']), requireAccess('rota'), checkRotaHome, async (req, res) => {
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
router.post('/:id/archive', requireRole(['admin', 'key_worker']), requireAccess('rota'), checkRotaHome, async (req, res) => {
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
router.post('/:id/revert', requireRole(['admin', 'key_worker']), requireAccess('rota'), checkRotaHome, async (req, res) => {
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
