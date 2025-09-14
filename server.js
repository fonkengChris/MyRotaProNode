const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

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
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

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
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
