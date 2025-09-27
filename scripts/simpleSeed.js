#!/usr/bin/env node

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Import models
const Home = require('../models/Home');

const MONGODB_URI = process.env.MONGODB_URI;

const seedHomes = async () => {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('Connected to database');

    const filePath = path.join(__dirname, '../backup_db/myrotapro.homes.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    console.log(`Found ${data.length} homes to insert`);
    
    // Clear existing data
    await Home.deleteMany({});
    console.log('Cleared existing homes');
    
    // Insert first home to test
    const firstHome = data[0];
    console.log('First home data:', JSON.stringify(firstHome, null, 2));
    
    // Convert ObjectId
    if (firstHome._id && firstHome._id.$oid) {
      firstHome._id = new mongoose.Types.ObjectId(firstHome._id.$oid);
    }
    if (firstHome.manager_id && firstHome.manager_id.$oid) {
      firstHome.manager_id = new mongoose.Types.ObjectId(firstHome.manager_id.$oid);
    }
    
    console.log('Processed home data:', JSON.stringify(firstHome, null, 2));
    
    const result = await Home.create(firstHome);
    console.log('Successfully inserted home:', result);
    
    // Check count
    const count = await Home.countDocuments();
    console.log(`Total homes in database: ${count}`);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.connection.close();
  }
};

seedHomes();
