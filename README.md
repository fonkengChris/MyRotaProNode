# MyRotaPro Backend

A comprehensive Node.js backend for the MyRotaPro rota management system, designed specifically for care settings.

## 🚀 Features

- **User Management**: Role-based access control with JWT authentication
- **Care Home Management**: Multi-home support with location tracking
- **Service Management**: Flexible service definitions with skill requirements
- **Rota Management**: Weekly rota creation, editing, and publishing
- **AI-Powered Scheduling**: Intelligent staff assignment using constraint optimization
- **Availability Tracking**: Staff availability and preference management
- **Time Off Management**: Request approval workflow
- **Real-time Validation**: Overlap detection and constraint checking

## 🏗️ Architecture

```
MyRotaProNode/
├── models/           # MongoDB schemas and models
├── routes/           # API endpoint definitions
├── middleware/       # Authentication and authorization
├── services/         # Business logic (AI solver, etc.)
├── server.js         # Main application entry point
└── package.json      # Dependencies and scripts
```

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT with bcrypt
- **Validation**: Express-validator
- **AI Solver**: Custom constraint optimization algorithm

## 📋 Prerequisites

- Node.js (v16 or higher)
- MongoDB (v5 or higher)
- npm or yarn

## 🚀 Installation

1. **Clone the repository**
   ```bash
   cd MyRotaProNode
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Database Setup**
   ```bash
   # Ensure MongoDB is running
   # The app will automatically create collections
   ```

5. **Start the server**
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm start
   ```

## ⚙️ Configuration

Create a `.env` file with the following variables:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# MongoDB Connection
MONGODB_URI=mongodb://localhost:27017/myrotapro

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRES_IN=7d

# Email Configuration
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password

# AI Solver Configuration
AI_SOLVER_TIMEOUT=30000
AI_SOLVER_MAX_ITERATIONS=1000
```

## 🗄️ Database Models

### User
- Authentication and profile information
- Role-based permissions (admin, home_manager, senior_staff, support_worker)
- Skills and shift preferences
- Home assignment

### Home
- Care home information and location
- Operating hours and capacity
- Manager assignment

### Service
- Service definitions with skill requirements
- Staffing requirements (min/max staff count)
- Duration and priority levels

### Shift
- Individual work shifts with time slots
- Staff assignments and status tracking
- Overlap detection and validation

### Rota
- Weekly rota management
- Status tracking (draft, published, archived)
- Shift aggregation and totals

### Availability
- Staff availability for specific dates
- Shift type and time preferences
- Maximum hours per day

### TimeOffRequest
- Time off request workflow
- Approval/denial tracking
- Date range validation

### ConstraintWeights
- AI solver configuration
- Hard and soft constraint definitions
- Customizable weights for optimization

## 🔐 Authentication & Authorization

### JWT Token Flow
1. User login/registration
2. Server generates JWT token
3. Client includes token in Authorization header
4. Middleware validates token and user permissions

### Role-Based Access Control
- **Admin**: Full system access
- **Home Manager**: Manage assigned home(s)
- **Senior Staff**: Partial rota management
- **Support Worker**: View rota and submit availability

## 🤖 AI Solver

The AI solver uses constraint optimization to automatically generate rota assignments:

### Hard Constraints (Must Not Violate)
- No double-booking staff
- Respect approved time off
- Meet minimum staffing requirements
- Required skills must be available

### Soft Constraints (Weighted Optimization)
- Staff shift preferences
- Even workload distribution
- Avoid overtime (>40 hours/week)
- Limit consecutive working days

### Algorithm
1. **Constraint Matrix**: Build availability scores for all staff-shift combinations
2. **Greedy Assignment**: Initial assignment using highest scores
3. **Local Search**: Optimize by swapping assignments to reduce penalties
4. **Validation**: Check against all constraints and return results

## 📡 API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User authentication
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/change-password` - Change password

### AI Solver
- `POST /api/ai-solver/generate-rota` - Generate rota using AI
- `POST /api/ai-solver/optimize-rota` - Optimize existing rota
- `POST /api/ai-solver/validate-rota` - Validate rota against constraints
- `GET /api/ai-solver/constraints` - Get constraint definitions
- `GET /api/ai-solver/performance` - Get solver performance metrics

### Health Check
- `GET /api/health` - Server health status

## 🔧 Development

### Scripts
```bash
npm run dev      # Start with nodemon (development)
npm start        # Start production server
npm test         # Run tests
```

### Code Structure
- **Models**: Database schemas with validation and methods
- **Routes**: API endpoint handlers with input validation
- **Middleware**: Authentication, authorization, and request processing
- **Services**: Business logic separated from route handlers

### Adding New Features
1. Create/update models in `models/`
2. Add routes in `routes/`
3. Implement business logic in `services/`
4. Add middleware if needed
5. Update `server.js` with new routes

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- --grep "User Model"
```

## 🚀 Deployment

### Production Build
```bash
# Install production dependencies
npm ci --only=production

# Set NODE_ENV
export NODE_ENV=production

# Start server
npm start
```

### Environment Variables
- Ensure all required environment variables are set
- Use strong JWT secrets
- Configure MongoDB connection string
- Set up email service credentials

### Monitoring
- Health check endpoint: `/api/health`
- Log all errors and important events
- Monitor MongoDB connection status
- Track AI solver performance metrics

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Submit a pull request

## 📝 License

This project is licensed under the MIT License.

## 🆘 Support

For support and questions:
- Check the API documentation
- Review the error logs
- Check MongoDB connection status
- Verify environment variable configuration

## 🔮 Future Enhancements

- **Real-time Updates**: WebSocket integration for live rota changes
- **Advanced AI**: Machine learning for better constraint optimization
- **Mobile API**: Optimized endpoints for mobile applications
- **Reporting**: Advanced analytics and reporting features
- **Integration**: Third-party calendar and HR system integration
