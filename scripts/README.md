# Test User Creation Script

This script creates 17 test users for development and testing purposes.

## User Breakdown

- **10 Support Workers**: Basic care staff members
- **5 Senior Staff**: Experienced care staff with additional responsibilities  
- **1 Home Manager**: Manages a specific care home
- **1 Admin**: System administrator with full access

## User Details

All users follow this pattern:
- **Names**: `{FirstName} {Role}` (e.g., "John Support", "Sarah Senior")
- **Emails**: `{firstname}_{role}@rcs.com` (e.g., "john_support@rcs.com")
- **Password**: `passWord123` (for all users)
- **Phone**: `+44123456789` (for all users)

## Usage

### Option 1: Using npm script (Recommended)
```bash
cd MyRotaProNode
npm run create-test-users
```

### Option 2: Direct execution
```bash
cd MyRotaProNode
node scripts/createTestUsers.js
```

## Prerequisites

1. MongoDB must be running
2. Environment variables must be configured (check `env.example`)
3. Node.js dependencies must be installed (`npm install`)

## What the Script Does

1. Connects to MongoDB using environment variables
2. Checks for existing users to avoid duplicates
3. Creates each user with appropriate role and permissions
4. Provides detailed console output of the process
5. Shows summary of created users and any errors

## Sample Output

```
✅ Created user: John Support (support_worker) - john_support@rcs.com
✅ Created user: Sarah Support (support_worker) - sarah_support@rcs.com
...

📊 SUMMARY:
✅ Successfully created: 17 users
❌ Failed to create: 0 users

🔑 All users have password: passWord123
📱 All users have phone: +44123456789
```

## Notes

- Users are created without home assignments initially
- All users have basic skills and shift preferences set
- The script skips users that already exist
- Users are created as active by default
- You can allocate users to homes later through the admin interface

## Troubleshooting

If you encounter errors:
1. Check MongoDB connection
2. Verify environment variables
3. Ensure all dependencies are installed
4. Check console output for specific error messages
