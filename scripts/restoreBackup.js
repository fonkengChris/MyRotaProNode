#!/usr/bin/env node

/**
 * Database Restoration Script
 * Restores backup JSON files to MongoDB
 * 
 * Usage:
 *   node scripts/restoreBackup.js
 *   npm run restore-backup
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const BACKUP_DIR = path.join(__dirname, '../backup_db');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro_prod';

// Collection mappings (filename -> collection name)
const COLLECTIONS = {
  'myrotapro.homes.json': 'homes',
  'myrotapro.services.json': 'services',
  'myrotapro.constraintweights.json': 'constraintweights',
  'myrotapro.availabilities.json': 'availabilities',
  'myrotapro.weeklyschedules.json': 'weeklyschedules'
};

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// Convert MongoDB Extended JSON to native MongoDB types
function convertExtendedJSON(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => convertExtendedJSON(item));
  }
  
  // Handle MongoDB Extended JSON types
  if (obj.$oid) {
    return new mongoose.Types.ObjectId(obj.$oid);
  }
  
  if (obj.$date) {
    return new Date(obj.$date);
  }
  
  if (obj.$numberInt) {
    return parseInt(obj.$numberInt);
  }
  
  if (obj.$numberLong) {
    return parseInt(obj.$numberLong);
  }
  
  if (obj.$numberDouble) {
    return parseFloat(obj.$numberDouble);
  }
  
  // Recursively convert nested objects
  const converted = {};
  for (const key in obj) {
    converted[key] = convertExtendedJSON(obj[key]);
  }
  
  return converted;
}

async function restoreCollection(collectionName, filePath) {
  try {
    log(`\n📁 Processing: ${path.basename(filePath)}`, 'blue');
    
    // Read backup file
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const rawDocuments = JSON.parse(fileContent);
    
    if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) {
      log(`  ⚠️  No documents found in ${path.basename(filePath)}`, 'yellow');
      return { success: true, count: 0 };
    }
    
    log(`  Found ${rawDocuments.length} documents`, 'blue');
    
    // Convert Extended JSON to native MongoDB types
    const documents = rawDocuments.map(doc => convertExtendedJSON(doc));
    
    // Get collection
    const collection = mongoose.connection.collection(collectionName);
    
    // Drop existing collection (optional - remove if you want to merge)
    try {
      await collection.drop();
      log(`  🗑️  Dropped existing collection`, 'yellow');
    } catch (err) {
      if (err.code !== 26) { // 26 = namespace not found
        throw err;
      }
      log(`  ℹ️  Collection doesn't exist yet`, 'blue');
    }
    
    // Insert documents
    const result = await collection.insertMany(documents, { ordered: false });
    
    log(`  ✅ Imported ${result.insertedCount} documents`, 'green');
    return { success: true, count: result.insertedCount };
    
  } catch (error) {
    log(`  ❌ Error: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

async function restoreDatabase() {
  try {
    log('🚀 Starting database restoration...', 'blue');
    log(`📂 Backup directory: ${BACKUP_DIR}`, 'blue');
    log(`🔗 MongoDB URI: ${MONGODB_URI.replace(/:[^:@]+@/, ':****@')}`, 'blue');
    
    // Connect to MongoDB
    log('\n🔌 Connecting to MongoDB...', 'blue');
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    log('✅ Connected to MongoDB', 'green');
    
    // Check if backup directory exists
    if (!fs.existsSync(BACKUP_DIR)) {
      throw new Error(`Backup directory not found: ${BACKUP_DIR}`);
    }
    
    // Restore each collection
    const results = {};
    let totalDocuments = 0;
    
    for (const [filename, collectionName] of Object.entries(COLLECTIONS)) {
      const filePath = path.join(BACKUP_DIR, filename);
      
      if (fs.existsSync(filePath)) {
        const result = await restoreCollection(collectionName, filePath);
        results[collectionName] = result;
        if (result.success) {
          totalDocuments += result.count;
        }
      } else {
        log(`\n⚠️  File not found: ${filename}`, 'yellow');
        results[collectionName] = { success: false, error: 'File not found' };
      }
    }
    
    // Summary
    log('\n' + '='.repeat(60), 'blue');
    log('📊 RESTORATION SUMMARY', 'blue');
    log('='.repeat(60), 'blue');
    
    for (const [collection, result] of Object.entries(results)) {
      if (result.success) {
        log(`✅ ${collection.padEnd(25)} ${result.count} documents`, 'green');
      } else {
        log(`❌ ${collection.padEnd(25)} ${result.error}`, 'red');
      }
    }
    
    log('='.repeat(60), 'blue');
    log(`\n🎉 Total documents imported: ${totalDocuments}`, 'green');
    log('✅ Database restoration completed!', 'green');
    
  } catch (error) {
    log('\n❌ RESTORATION FAILED', 'red');
    log(`Error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    log('\n🔌 Disconnected from MongoDB', 'blue');
  }
}

// Run restoration
if (require.main === module) {
  restoreDatabase()
    .then(() => {
      log('\n✨ Done!', 'green');
      process.exit(0);
    })
    .catch((error) => {
      log(`\n💥 Unexpected error: ${error.message}`, 'red');
      console.error(error);
      process.exit(1);
    });
}

module.exports = { restoreDatabase };

