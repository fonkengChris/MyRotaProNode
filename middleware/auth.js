const jwt = require('jsonwebtoken');
const User = require('../models/User');

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
    const user = await User.findById(decoded.userId).select('-password');
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
      
      // Check if user belongs to the home (check homes array)
      if (req.user.homes && req.user.homes.some(home => home.home_id.toString() === homeId.toString())) {
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
          if (['home_manager', 'senior_staff'].includes(req.user.role)) {
            return next();
          }
          break;
          
        case 'user':
          // Check if user is managing someone in their home
          if (['home_manager'].includes(req.user.role)) {
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
  requireOwnershipOrPermission
};
