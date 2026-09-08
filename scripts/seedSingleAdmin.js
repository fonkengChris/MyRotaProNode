#!/usr/bin/env node

/**
 * Seed (or update) a single admin user — non-destructive.
 *
 * Does NOT wipe any collections. Upserts one admin by email: creates it if
 * missing, or updates name/phone/role and resets the password if it exists.
 * The plaintext password is hashed by the User model's pre-save hook.
 *
 * Config via environment variables (so no secrets are written to disk):
 *   MONGODB_URI     (required) — target database
 *   ADMIN_EMAIL     (required) — admin email
 *   ADMIN_NAME      (optional) — display name (defaults from email)
 *   ADMIN_PASSWORD  (required) — plaintext password to set
 *   ADMIN_PHONE     (optional) — defaults to a placeholder
 *
 * Usage:
 *   MONGODB_URI="..." ADMIN_EMAIL="..." ADMIN_PASSWORD="..." node scripts/seedSingleAdmin.js
 */

const mongoose = require('mongoose');
const User = require('../models/User');

const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME =
  process.env.ADMIN_NAME ||
  (ADMIN_EMAIL ? ADMIN_EMAIL.split('@')[0].replace(/[._]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+447700900001';

const seed = async () => {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is required');
  if (!ADMIN_EMAIL) throw new Error('ADMIN_EMAIL is required');
  if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD is required');

  const admin = {
    name: ADMIN_NAME,
    email: ADMIN_EMAIL.toLowerCase().trim(),
    phone: ADMIN_PHONE,
    password: ADMIN_PASSWORD,
    role: 'admin',
    type: 'fulltime',
    min_hours_per_week: 40,
    max_hours_per_week: 40,
    is_active: true,
    skills: ['medication', 'personal_care'],
    preferred_shift_types: ['day'],
  };

  console.log('Connecting to database...');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.');

  const existing = await User.findOne({ email: admin.email });
  if (existing) {
    Object.assign(existing, admin);
    await existing.save();
    console.log(`Updated existing admin: ${admin.email}`);
  } else {
    await User.create(admin);
    console.log(`Created admin: ${admin.email}`);
  }

  console.log('\n--- Login credentials ---');
  console.log(`  Name:     ${admin.name}`);
  console.log(`  Email:    ${admin.email}`);
  console.log(`  Password: ${ADMIN_PASSWORD}`);
  console.log(`  Role:     ${admin.role}`);
};

seed()
  .catch(err => {
    console.error('Error seeding admin:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
  });
