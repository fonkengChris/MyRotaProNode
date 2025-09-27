// Environment configuration and validation
const requiredEnvVars = {
  production: ['MONGODB_URI', 'JWT_SECRET'],
  development: ['MONGODB_URI'],
  test: ['MONGODB_URI']
}

// Validate environment variables
const validateEnv = () => {
  const env = process.env.NODE_ENV || 'development'
  const required = requiredEnvVars[env] || []
  
  const missing = required.filter(varName => !process.env[varName])
  
  if (missing.length > 0) {
    console.error(`❌ Missing required environment variables for ${env}: ${missing.join(', ')}`)
    process.exit(1)
  }
}

// Get environment configuration
const getConfig = () => {
  const env = process.env.NODE_ENV || 'development'
  
  // Validate in production
  if (env === 'production') {
    validateEnv()
  }

  return {
    env,
    port: parseInt(process.env.PORT) || 5000,
    mongodb: {
      uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/myrotapro_dev'
    },
    jwt: {
      secret: process.env.JWT_SECRET || 'dev-jwt-secret',
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    },
    cors: {
      origin: process.env.CORS_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000'
    },
    email: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    ai: {
      timeout: parseInt(process.env.AI_SOLVER_TIMEOUT) || 30000,
      maxIterations: parseInt(process.env.AI_SOLVER_MAX_ITERATIONS) || 1000
    },
    security: {
      rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
      rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || (env === 'development' ? 1000 : 100)
    },
    logging: {
      level: process.env.LOG_LEVEL || (env === 'development' ? 'debug' : 'info')
    }
  }
}

// Environment helpers
const isDevelopment = () => getConfig().env === 'development'
const isProduction = () => getConfig().env === 'production'
const isTest = () => getConfig().env === 'test'

// Log configuration in development
if (isDevelopment()) {
  console.log('🔧 Development Environment Configuration')
  console.log('Config:', JSON.stringify(getConfig(), null, 2))
}

module.exports = {
  getConfig,
  isDevelopment,
  isProduction,
  isTest,
  validateEnv
}
