#!/usr/bin/env node

/**
 * Seed an admin user.
 *
 * Usage: node scripts/seedAdminUser.js
 *
 * Creates (or updates) a single admin account. The password is passed in
 * plain text; the User model's pre-save hook hashes it with bcrypt.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro';

const ADMIN = {
  name: 'Chris Admin',
  email: 'chris_admin@myrotapro.com',
  phone: '+447700900000',
  password: 'Password123#',
  role: 'admin',
  type: 'fulltime',
  min_hours_per_week: 40,
  max_hours_per_week: 40,
  is_active: true,
  skills: ['medication', 'personal_care'],
  preferred_shift_types: ['day'],
};

const seedAdmin = async () => {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to database');

    const existing = await User.findOne({ email: ADMIN.email });

    if (existing) {
      // Update fields and reset password (assigning triggers the hashing hook on save).
      Object.assign(existing, ADMIN);
      await existing.save();
      console.log(`Updated existing admin user: ${ADMIN.email}`);
    } else {
      await User.create(ADMIN);
      console.log(`Created admin user: ${ADMIN.email}`);
    }

    console.log('\nLogin credentials:');
    console.log(`  Email:    ${ADMIN.email}`);
    console.log(`  Password: ${ADMIN.password}`);
    console.log(`  Role:     ${ADMIN.role}`);
  } catch (error) {
    console.error('Error seeding admin user:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  }
};

seedAdmin();
