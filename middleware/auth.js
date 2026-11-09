const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ServiceUser = require('../models/ServiceUser');
const KeyWorkerAccessSettings = require('../models/KeyWorkerAccessSettings');

// Middleware to authenticate JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Access denied. No token provided.' 
      });
    }
    
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database
    const user = await User.findById(decoded.userId).select('-password +key_worker_access');
    if (!user) {
      return res.status(401).json({ 
        error: 'Invalid token. User not found.' 
      });
    }
    
    if (!user.is_active) {
      return res.status(401).json({ 
        error: 'Account is deactivated.' 
      });
    }

    // A password change or reset revokes every token issued before it.
    if (user.password_changed_at && decoded.iat * 1000 < user.password_changed_at.getTime()) {
      return res.status(401).json({
        error: 'Password was changed. Please log in again.'
      });
    }
    
    // Key workers aren't tied to houses: they also reach the homes their service
    // users live in. Resolved once per request; read via getUserHomeIds().
    if (user.role === 'key_worker') {
      user.$locals.serviceUserHomeIds = await ServiceUser.getHomeIdsForKeyWorker(user._id);
      user.$locals.keyWorkerAccess = await KeyWorkerAccessSettings.resolveFor(user.key_worker_access);
    }

    // Add user to request object
    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        error: 'Invalid token.' 
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expired.' 
      });
    }
    
    console.error('Auth middleware error:', error);
    return res.status(500).json({ 
      error: 'Internal server error during authentication.' 
    });
  }
};

// Roles that may access management pages/data.
// Admins see every home; key workers are scoped to their own home(s) plus the
// homes their service users live in.
const MANAGER_ROLES = ['admin', 'key_worker'];

// Return the list of home id strings a user can access: homes they're attached to,
// plus (for key workers loaded via authenticateToken) their service users' homes.
const getUserHomeIds = (user) => {
  if (!user) return [];
  const direct = Array.isArray(user.homes)
    ? user.homes
      .filter(home => home && home.home_id)
      .map(home => home.home_id.toString())
    : [];
  const viaServiceUsers = (user.$locals && user.$locals.serviceUserHomeIds) || [];
  return [...new Set([...direct, ...viaServiceUsers])];
};

// Whether a user holds a level of key worker access (see KeyWorkerAccessSettings). Admins
// hold everything. Other roles hold nothing: their access stays role-based.
const hasAccess = (user, area, level = 'full') => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'key_worker') return false;
  const value = user.$locals && user.$locals.keyWorkerAccess && user.$locals.keyWorkerAccess[area];
  // `full` includes `view`.
  return level === 'view' ? value === 'view' || value === 'full' : value === level;
};

// Whether the user reaches every home for this area. A hidden area never widens reach.
const reachesAllHomes = (user, area) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return hasAccess(user, area, 'view') && user.$locals.keyWorkerAccess.home_scope === 'all';
};

// Whether the user reaches this home for this area.
const canReachHome = (user, area, homeId) => {
  if (reachesAllHomes(user, area)) return true;
  return !!homeId && getUserHomeIds(user).includes(homeId.toString());
};

// True when a key worker's home scope doesn't cover this home. Other roles are never out of
// scope here: their route guards decide for them.
const keyWorkerOutOfScope = (user, area, homeId) =>
  !!user && user.role === 'key_worker' && !canReachHome(user, area, homeId);

// Whether any management area gives this user every home (home pickers and service lists).
const reachesAllHomesInAnyArea = (user) =>
  ['staff', 'weekly_schedules', 'rota'].some(area => reachesAllHomes(user, area));

// Guards a route for key workers by access level. Other roles pass through, so pair this
// with requireRole, which decides for them.
const requireAccess = (area, level = 'full') => (req, res, next) => {
  if (req.user && req.user.role === 'key_worker' && !hasAccess(req.user, area, level)) {
    return res.status(403).json({ error: 'Your access level does not allow this. Please ask an admin.' });
  }
  next();
};

// True when the user is allowed to reach management-only functionality.
const isManager = (user) => !!user && MANAGER_ROLES.includes(user.role);

// Middleware to check if user has required role
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Authentication required.' 
      });
    }
    
    const userRole = req.user.role;
    
    if (Array.isArray(roles)) {
      if (!roles.includes(userRole)) {
        return res.status(403).json({ 
          error: 'Insufficient permissions. Required roles: ' + roles.join(', ') 
        });
      }
    } else {
      if (userRole !== roles) {
        return res.status(403).json({ 
          error: 'Insufficient permissions. Required role: ' + roles 
        });
      }
    }
    
    next();
  };
};

// Middleware to check if user can access specific home
const requireHomeAccess = (homeIdParam = 'homeId') => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ 
          error: 'Authentication required.' 
        });
      }
      
      const homeId = req.params[homeIdParam] || req.body.home_id;
      
      // Admin can access all homes
      if (req.user.role === 'admin') {
        return next();
      }
      
      // Check if user can access the home (own homes or service users' homes)
      if (homeId && getUserHomeIds(req.user).includes(homeId.toString())) {
        return next();
      }
      
      return res.status(403).json({ 
        error: 'Access denied. You can only access your assigned homes.' 
      });
    } catch (error) {
      console.error('Home access middleware error:', error);
      return res.status(500).json({ 
        error: 'Internal server error during home access check.' 
      });
    }
  };
};

// Middleware to check if user can manage specific resource
const requireResourceAccess = (resourceType, resourceIdParam) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ 
          error: 'Authentication required.' 
        });
      }
      
      // Admin can access all resources
      if (req.user.role === 'admin') {
        return next();
      }
      
      const resourceId = req.params[resourceIdParam];
      
      // For now, we'll implement basic checks
      // This could be enhanced with more sophisticated resource ownership logic
      switch (resourceType) {
        case 'rota':
          // Check if user can manage rotas for the home
          if (['key_worker', 'senior_staff'].includes(req.user.role)) {
            return next();
          }
          break;
          
        case 'user':
          // Check if user is managing someone in their home
          if (['key_worker'].includes(req.user.role)) {
            return next();
          }
          break;
          
        default:
          return res.status(403).json({ 
            error: 'Access denied for this resource type.' 
          });
      }
      
      return res.status(403).json({ 
        error: 'Insufficient permissions to access this resource.' 
      });
    } catch (error) {
      console.error('Resource access middleware error:', error);
      return res.status(500).json({ 
        error: 'Internal server error during resource access check.' 
      });
    }
  };
};

// Middleware to check if user can view their own data
const requireOwnershipOrPermission = (resourceType, resourceIdParam, permissionRoles) => {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ 
          error: 'Authentication required.' 
        });
      }
      
      const resourceId = req.params[resourceIdParam];
      
      // Admin can access all resources
      if (req.user.role === 'admin') {
        return next();
      }
      
      // Check if user has permission role
      if (permissionRoles && permissionRoles.includes(req.user.role)) {
        return next();
      }
      
      // Check if user owns the resource
      if (resourceId === req.user._id.toString()) {
        return next();
      }
      
      return res.status(403).json({ 
        error: 'Access denied. You can only access your own data or have insufficient permissions.' 
      });
    } catch (error) {
      console.error('Ownership middleware error:', error);
      return res.status(500).json({ 
        error: 'Internal server error during ownership check.' 
      });
    }
  };
};

module.exports = {
  authenticateToken,
  requireRole,
  requireHomeAccess,
  requireResourceAccess,
  requireOwnershipOrPermission,
  requireManager: requireRole(MANAGER_ROLES),
  MANAGER_ROLES,
  getUserHomeIds,
  hasAccess,
  reachesAllHomes,
  canReachHome,
  keyWorkerOutOfScope,
  reachesAllHomesInAnyArea,
  requireAccess,
  isManager
};
