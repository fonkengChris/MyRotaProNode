// Test helper to ensure MongoDB is connected before importing server
// This should be imported before any test files that import server.js
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;
let isConnected = false;

async function ensureConnection() {
  if (!isConnected && mongoose.connection.readyState === 0) {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    isConnected = true;
  }
  return mongoose.connection;
}

module.exports = { ensureConnection, mongoServer };

