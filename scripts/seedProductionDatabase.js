#!/usr/bin/env node

/**
 * Production Database Seeding Script
 * This script seeds the production database with data from backup JSON files
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Import models
const Home = require('../models/Home');
const User = require('../models/User');
const Service = require('../models/Service');
const WeeklySchedule = require('../models/WeeklySchedule');
const ConstraintWeight = require('../models/ConstraintWeights');
const Availability = require('../models/Availability');

// Configuration
const BACKUP_DIR = path.join(__dirname, '../backup_db');
const MONGODB_URI = process.env.MONGODB_URI;

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

const log = {
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  warning: (msg) => console.log(`${colors.yellow}⚠${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  step: (msg) => console.log(`${colors.cyan}→${colors.reset} ${msg}`)
};

// Helper function to convert MongoDB ObjectId format
const convertObjectId = (obj) => {
  if (obj && obj.$oid) {
    return new mongoose.Types.ObjectId(obj.$oid);
  }
  return obj;
};

// Helper function to convert MongoDB Date format
const convertDate = (obj) => {
  if (obj && obj.$date) {
    return new Date(obj.$date);
  }
  return obj;
};

// Helper function to process document
const processDocument = (doc) => {
  const processed = { ...doc };
  
  // Convert ObjectId fields
  if (processed._id) {
    processed._id = convertObjectId(processed._id);
  }
  
  // Convert all fields
  Object.keys(processed).forEach(key => {
    if (Array.isArray(processed[key])) {
      processed[key] = processed[key].map(item => {
        if (typeof item === 'object' && item.$oid) {
          return convertObjectId(item);
        } else if (typeof item === 'object' && item.$date) {
          return convertDate(item);
        }
        return item;
      });
    } else if (typeof processed[key] === 'object' && processed[key]) {
      if (processed[key].$oid) {
        processed[key] = convertObjectId(processed[key]);
      } else if (processed[key].$date) {
        processed[key] = convertDate(processed[key]);
      }
    }
  });
  
  return processed;
};

// Load and seed data for a specific collection
const seedCollection = async (Model, filename, collectionName) => {
  try {
    log.step(`Seeding ${collectionName}...`);
    
    const filePath = path.join(BACKUP_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
      log.warning(`File not found: ${filename}`);
      return;
    }
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    if (!Array.isArray(data) || data.length === 0) {
      log.warning(`No data found in ${filename}`);
      return;
    }
    
    // Clear existing data
    await Model.deleteMany({});
    log.info(`Cleared existing ${collectionName} data`);
    
    // Process and insert data
    const processedData = data.map(processDocument);
    
    // Insert in batches to avoid memory issues
    const batchSize = 100;
    let inserted = 0;
    
    for (let i = 0; i < processedData.length; i += batchSize) {
      const batch = processedData.slice(i, i + batchSize);
      await Model.insertMany(batch, { ordered: false });
      inserted += batch.length;
      log.info(`Inserted ${inserted}/${processedData.length} ${collectionName} documents`);
    }
    
    log.success(`Successfully seeded ${collectionName}: ${inserted} documents`);
    
  } catch (error) {
    log.error(`Error seeding ${collectionName}: ${error.message}`);
    throw error;
  }
};

// Main seeding function
const seedDatabase = async () => {
  try {
    log.info('Starting production database seeding...');
    
    // Validate environment
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI environment variable is required');
    }
    
    if (!fs.existsSync(BACKUP_DIR)) {
      throw new Error(`Backup directory not found: ${BACKUP_DIR}`);
    }
    
    // Connect to database
    log.step('Connecting to production database...');
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    log.success('Connected to production database');
    
    // Log database info
    const db = mongoose.connection.db;
    log.info(`Database: ${db.databaseName}`);
    
    // Seed collections in order (respecting dependencies)
    const collections = [
      { Model: Home, filename: 'myrotapro.homes.json', name: 'Homes' },
      { Model: User, filename: 'myrotapro.users.json', name: 'Users' },
      { Model: Service, filename: 'myrotapro.services.json', name: 'Services' },
      { Model: WeeklySchedule, filename: 'myrotapro.weeklyschedules.json', name: 'Weekly Schedules' },
      { Model: ConstraintWeight, filename: 'myrotapro.constraintweights.json', name: 'Constraint Weights' },
      { Model: Availability, filename: 'myrotapro.availabilities.json', name: 'Availabilities' }
    ];
    
    for (const collection of collections) {
      await seedCollection(collection.Model, collection.filename, collection.name);
    }
    
    log.success('Database seeding completed successfully!');
    
    // Display summary
    log.info('\n📊 Seeding Summary:');
    for (const collection of collections) {
      const count = await collection.Model.countDocuments();
      log.info(`  ${collection.name}: ${count} documents`);
    }
    
  } catch (error) {
    log.error(`Seeding failed: ${error.message}`);
    process.exit(1);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    log.info('Database connection closed');
  }
};

// Run the seeding script
if (require.main === module) {
  seedDatabase();
}

module.exports = { seedDatabase };
