# Production User Seeding Scripts

This directory contains scripts to seed users in the production database for MyRotaPro.

## Scripts Overview

### 1. `seedProductionUsers.js`
The main seeding script that creates users based on homes and services in the database.

### 2. `runUserSeeding.js`
A wrapper script to run the seeding process with proper error handling.

### 3. `verifySeededUsers.js`
A verification script to check the seeded data and provide statistics.

## User Creation Rules

Based on the backup data analysis, the script creates users according to these rules:

### Regular Homes (Supported Living)
- **4 Fulltime Users**: 3 support_worker + 1 senior_staff
- **2 Parttime Users**: support_worker role
- **2 Bank Workers**: support_worker role
- **2 Cross-Home Workers**: Can work in multiple supported living homes

### Outreach/Community Homes
- **1-2 Staff Only**: support_worker role (no senior_staff)
- Based on services like "Community Outreach"

## User Details

### Authentication
- **Password**: `passWord123#` (for all users)
- **Email Domain**: `@myrotapro.com`
- **Email Format**: `firstname.lastname.homename.role@myrotapro.com`

### User Attributes
- **Skills**: Randomly assigned based on role
  - Support Workers: medication, personal_care, domestic_support, social_support
  - Senior Staff: All support worker skills + specialist_care
- **Shift Preferences**: Randomly assigned from morning, afternoon, night, long_day
- **Hours**: Based on employment type
  - Fulltime: 40 hours/week
  - Parttime: 20-30 hours/week
  - Bank: 0-20 hours/week

## Usage

### Run User Seeding
```bash
cd MyRotaProNode
node scripts/runUserSeeding.js
```

### Verify Seeded Users
```bash
cd MyRotaProNode
node scripts/verifySeededUsers.js
```

### Direct Script Usage
```bash
cd MyRotaProNode
node scripts/seedProductionUsers.js
```

## Database Connection

The scripts connect to the production MongoDB database:
```
mongodb+srv://chrisfonkeng:chrisfonkeng123@cluster0.8qj8x.mongodb.net/myrotapro
```

## Expected Results

Based on the backup data (8 homes, 4 services):

### Homes Breakdown
- **Hope House**: Supported Living (8 users)
- **Peace Home**: Supported Living (8 users)
- **Happy House**: Supported Living (8 users)
- **Love House**: Supported Living (8 users)
- **Gentle House**: Supported Living (8 users)
- **Compassion House**: Day Center (8 users)
- **Lansdowne House**: Community Outreach (1-2 users)
- **Office**: Administrative (8 users)

### Total Expected Users
- Regular homes: 7 × 8 = 56 users
- Outreach homes: 1 × 2 = 2 users
- Cross-home workers: ~16 users
- **Total**: ~74 users

## Safety Features

- **Duplicate Prevention**: Uses email uniqueness to prevent duplicate users
- **Batch Processing**: Creates users in batches of 50 to avoid memory issues
- **Error Handling**: Gracefully handles duplicate key errors
- **Verification**: Includes comprehensive verification script

## Monitoring

After running the seeding script, use the verification script to:
- Check total user count
- Verify email domains
- Analyze users by role and type
- Check cross-home assignments
- Verify password functionality
- Validate outreach home staffing

## Troubleshooting

### Common Issues
1. **Connection Errors**: Check MongoDB URI and network connectivity
2. **Duplicate Users**: Script handles this gracefully, skipping existing users
3. **Memory Issues**: Script uses batch processing to handle large datasets

### Logs
The scripts provide detailed logging including:
- Connection status
- Homes and services found
- Users created per batch
- Final statistics and summary
