const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const KeyWorkerAccessSettings = require('../models/KeyWorkerAccessSettings');
const { authenticateToken } = require('../middleware/auth');
const { getConfig } = require('../config/env');
const { sendPasswordResetEmail } = require('../services/emailService');

const router = express.Router();

// Tight per-IP limit on the public reset endpoints so they can't be used to spam
// inboxes or brute-force tokens.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many password reset attempts. Please try again in 15 minutes.' }
});

const signToken = (userId) => jwt.sign(
  { userId },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

// Where reset links point. FRONTEND_URL wins; otherwise the first concrete CORS origin.
const frontendUrl = () => {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL.replace(/\/+$/, '');
  const origin = String(getConfig().cors.origin || '')
    .split(',')
    .map(s => s.trim())
    .find(s => s && s !== '*');
  return (origin || 'http://localhost:3000').replace(/\/+$/, '');
};

const FORGOT_PASSWORD_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

// Public self-registration has been removed. New users are created by an admin
// via POST /api/users (see routes/users.js).

// @route   POST /api/auth/login
// @desc    Authenticate user & get token
// @access  Public
router.post('/login', [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { email, password } = req.body;

    // Find user by email and include password for comparison
    const user = await User.findOne({ email }).select('+password +key_worker_access');
    if (!user) {
      return res.status(400).json({ 
        error: 'Invalid credentials' 
      });
    }

    // Check if user is active
    if (!user.is_active) {
      return res.status(400).json({ 
        error: 'Account is deactivated. Please contact administrator.' 
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(400).json({ 
        error: 'Invalid credentials' 
      });
    }

    // Generate JWT token
    const token = signToken(user._id);

    // Return user info (without password) and token
    res.json({
      message: 'Login successful',
      user: {
        ...user.publicInfo,
        access: user.role === 'key_worker' ? await KeyWorkerAccessSettings.resolveFor(user.key_worker_access) : undefined
      },
      token,
      permissions: user.getPermissions()
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Server error during login' 
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user info
// @access  Private
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('homes.home_id', 'name location');
    
    res.json({
      user: {
        ...user.publicInfo,
        // Homes reached through the key worker's service users (empty for other roles).
        service_user_home_ids: req.user.$locals.serviceUserHomeIds || [],
        // Effective key worker access (absent for other roles, whose access is role-based).
        access: req.user.$locals.keyWorkerAccess
      },
      permissions: user.getPermissions()
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ 
      error: 'Server error while fetching user info' 
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh JWT token
// @access  Private
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    // Generate new token
    const token = signToken(req.user._id);

    res.json({
      message: 'Token refreshed successfully',
      token
    });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ 
      error: 'Server error while refreshing token' 
    });
  }
});

// @route   POST /api/auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password', [
  authenticateToken,
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters long')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        error: 'Validation failed', 
        details: errors.array() 
      });
    }

    const { currentPassword, newPassword } = req.body;

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({ 
        error: 'User not found' 
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ 
        error: 'Current password is incorrect' 
      });
    }

    // Update password
    user.password = newPassword;
    user.must_change_password = false;
    await user.save();

    // The change revokes tokens issued before it, so hand this session a new one.
    res.json({
      message: 'Password changed successfully',
      token: signToken(user._id)
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ 
      error: 'Server error while changing password' 
    });
  }
});

// @route   POST /api/auth/forgot-password
// @desc    Email a one-time password reset link
// @access  Public
router.post('/forgot-password', passwordResetLimiter, [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    // Same response whether or not the account exists, so this can't be used to
    // discover who has an account.
    const user = await User.findOne({ email: req.body.email, is_active: true });
    if (user) {
      const token = user.createPasswordResetToken();
      await user.save({ validateBeforeSave: false });
      await sendPasswordResetEmail(user, `${frontendUrl()}/reset-password?token=${token}`);
    }

    res.json({ message: FORGOT_PASSWORD_MESSAGE });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      error: 'Server error while requesting password reset'
    });
  }
});

// @route   POST /api/auth/reset-password
// @desc    Set a new password using an emailed reset token
// @access  Public
router.post('/reset-password', passwordResetLimiter, [
  body('token').isString().notEmpty().withMessage('Reset token is required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters long')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { token, newPassword } = req.body;

    const user = await User.findOne({
      password_reset_token_hash: User.hashResetToken(token),
      password_reset_expires: { $gt: new Date() },
      is_active: true
    });
    if (!user) {
      return res.status(400).json({
        error: 'Reset link is invalid or has expired. Please request a new one.'
      });
    }

    user.password = newPassword;
    user.password_reset_token_hash = undefined;
    user.password_reset_expires = undefined;
    user.must_change_password = false;
    await user.save();

    res.json({
      message: 'Password has been reset. You can now sign in.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      error: 'Server error while resetting password'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user (client-side token removal)
// @access  Private
router.post('/logout', authenticateToken, (req, res) => {
  // In a stateless JWT system, logout is handled client-side
  // by removing the token. This endpoint can be used for logging.
  res.json({
    message: 'Logout successful'
  });
});

module.exports = router;
