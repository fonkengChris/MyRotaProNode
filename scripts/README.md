# MyRotaPro Scripts

This directory contains utility scripts for managing and analyzing the MyRotaPro system.

## Available Scripts

### 1. `createTestUsers.js`
Creates test users with different roles for development and testing purposes.

**Usage:**
```bash
cd MyRotaProNode/scripts
node createTestUsers.js
```

**Features:**
- Creates 17 test users with different roles
- All users have password: `passWord123`
- All users have phone: `+44123456789`
- Default employment type: `fulltime`

### 2. `analyzeHomeStaffing.js` ⭐ NEW
Analyzes the distribution of staff across homes and their employment types.

**Usage:**
```bash
cd MyRotaProNode/scripts
node analyzeHomeStaffing.js
```

**Features:**
- **Home-by-home analysis**: Shows staff count and distribution for each home
- **Employment type breakdown**: Full-time, part-time, and bank staff counts
- **Role distribution**: Admin, home manager, senior staff, support worker counts
- **Staffing insights**: Identifies potential staffing issues and gaps
- **Recommendations**: Provides suggestions for workforce optimization
- **CSV export**: Generate detailed reports for further analysis

**Options:**
```bash
# Standard analysis (console output)
node analyzeHomeStaffing.js

# Generate CSV report
node analyzeHomeStaffing.js --csv
# or
node analyzeHomeStaffing.js -c
```

**Sample Output:**
```
🏠 HOME STAFFING ANALYSIS
================================================================================

📍 HOME: Maple House
   Location: Manchester, M1 1AA
   Manager: John Manager
------------------------------------------------------------
   👥 Total Staff: 8
   📊 Breakdown by Type:
      🟢 Full Time: 5
         - John Manager (home_manager)
         - Sarah Support (support_worker)
         - Mike Support (support_worker)
         - Emma Support (support_worker)
         - David Support (support_worker)
      🟡 Part Time: 2
         - Lisa Support (support_worker)
         - Tom Support (support_worker)
      🔵 Bank: 1
         - Anna Support (support_worker)
   📈 Percentages:
      Full Time: 62.5%
      Part Time: 25.0%
      Bank: 12.5%
   🎭 Role Distribution:
      Home Manager: 1
      Support Worker: 7
```

### 3. `checkDatabase.js`
Verifies database connectivity and basic operations.

### 4. `checkUserHomes.js`
Checks user home allocations and identifies any inconsistencies.

### 5. `createAvailabilityForWeek.js`
Creates availability records for a specific week.

### 6. `createConstraints.js`
Sets up constraint weights for the AI solver.

### 7. `createWeeklyShifts.js`
Creates weekly shift templates.

### 8. `migrateUsersToNewSchema.js`
Migrates users from old schema to new homes array structure.

### 9. `setupAndTestConstraints.js`
Sets up and tests constraint configurations.

### 10. `testHoursConstraints.js`
Tests hour-based constraint validation.

### 11. `updateUserHomes.js`
Updates user home allocations.

## Prerequisites

Before running any scripts:

1. **Install dependencies:**
   ```bash
   cd MyRotaProNode
   npm install
   ```

2. **Set up environment:**
   - Copy `env.example` to `.env` in the MyRotaProNode directory
   - Configure your MongoDB connection string
   - Set other required environment variables

3. **Ensure MongoDB is running:**
   ```bash
   # Check if MongoDB is running
   sudo systemctl status mongod
   
   # Start MongoDB if needed
   sudo systemctl start mongod
   ```

## Common Use Cases

### Workforce Planning
```bash
# Analyze current staffing levels
node analyzeHomeStaffing.js

# Generate report for stakeholders
node analyzeHomeStaffing.js --csv
```

### Development Setup
```bash
# Create test users for development
node createTestUsers.js

# Verify database connectivity
node checkDatabase.js
```

### Data Migration
```bash
# Migrate users to new schema
node migrateUsersToNewSchema.js

# Update home allocations
node updateUserHomes.js
```

## Output Files

- **CSV Reports**: Generated in the scripts directory with timestamp
- **Console Output**: Detailed analysis with emojis and formatting
- **Error Logs**: Comprehensive error reporting for troubleshooting

## Troubleshooting

### Common Issues

1. **Connection Error**: Ensure MongoDB is running and connection string is correct
2. **Permission Error**: Check file permissions for CSV generation
3. **Schema Mismatch**: Ensure models are up to date with latest schema changes

### Getting Help

- Check the console output for detailed error messages
- Verify database connectivity with `checkDatabase.js`
- Ensure all required environment variables are set

## Contributing

When adding new scripts:

1. Follow the existing naming convention
2. Include comprehensive error handling
3. Add documentation to this README
4. Test with different data scenarios
5. Include both console and file output options where appropriate
