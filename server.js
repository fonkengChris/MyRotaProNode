const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// Load environment variables
dotenv.config();

// Load configuration
const { getConfig, isDevelopment, isProduction } = require('./config/env');
const config = getConfig();

// Import routes
const setupRoutes = require('./routes/setup');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const homeRoutes = require('./routes/homes');
const serviceRoutes = require('./routes/services');
const shiftRoutes = require('./routes/shifts');
const weeklyScheduleRoutes = require('./routes/weeklySchedules');
const rotaRoutes = require('./routes/rotas');
const availabilityRoutes = require('./routes/availability');
const timeOffRoutes = require('./routes/timeOff');
const aiSolverRoutes = require('./routes/aiSolver');
const shiftSwapRoutes = require('./routes/shiftSwaps');
const timetableRoutes = require('./routes/timetables');

// Import middleware
const { authenticateToken } = require('./middleware/auth');

const app = express();
const PORT = config.port;

// Security middleware (only in production)
if (isProduction()) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
  }));
}

// Rate limiting
const limiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs,
  max: config.security.rateLimitMaxRequests,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Compression middleware
app.use(compression());

// CORS configuration
const corsOptions = {
  origin: config.cors.origin,
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Database connection
mongoose.connect(config.mongodb.uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

// Routes
app.use('/api/setup', setupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/homes', authenticateToken, homeRoutes);
app.use('/api/services', authenticateToken, serviceRoutes);
app.use('/api/shifts', authenticateToken, shiftRoutes);
app.use('/api/weekly-schedules', authenticateToken, weeklyScheduleRoutes);
app.use('/api/rotas', authenticateToken, rotaRoutes);
app.use('/api/availability', authenticateToken, availabilityRoutes);
app.use('/api/timeoff', authenticateToken, timeOffRoutes);
app.use('/api/ai-solver', authenticateToken, aiSolverRoutes);
app.use('/api/shift-swaps', authenticateToken, shiftSwapRoutes);
app.use('/api/timetables', authenticateToken, timetableRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Log error details in production
  if (isProduction()) {
    console.error('Stack:', err.stack);
  }
  
  res.status(err.status || 500).json({ 
    error: 'Internal server error',
    message: isDevelopment() ? err.message : 'Something went wrong',
    ...(isDevelopment() && { stack: err.stack })
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Environment: ${config.env}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
  
  if (isDevelopment()) {
    console.log(`🌐 CORS Origin: ${config.cors.origin}`);
    console.log(`🗄️  Database: ${config.mongodb.uri}`);
  }
});

module.exports = app;
