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

---

## `seedStaffFromSpreadsheet.js` — real staff from "Staff for scheduler.xlsx"

Seeds the 45 real staff members transcribed from `Staff for scheduler.xlsx` (project
root). Unlike the generator scripts above, this one uses the actual names, personal
email addresses and phone numbers — it is the script to run against production.

### Configuration comes from `.env.production`

The script loads `MyRotaProNode/.env.production` itself (with `override: true`), so the
target cluster is whatever `MONGODB_URI` that file names — a stale `MONGODB_URI` in your
shell cannot redirect the seed. Pass `--env-file=<path>` to target a different
environment. The env file is echoed back (credentials masked) before anything is written.

| Variable | Used for | Default |
|---|---|---|
| `MONGODB_URI` | target database (required) | — |
| `STAFF_SEED_EMAIL_DOMAIN` | domain for placeholder emails | `rcsrota.co.uk` |

### Roles (from the sheet's blocks)

| Sheet block | Rows | Count | Role |
|---|---|---|---|
| (no header) | 1–6 | 5 | `key_worker` |
| SUPPORT WORKER / SUPPORTED LIVING | 10–47 | 37 | `support_worker` |
| CARE ASSISTANT / OUTREACH | 50–52 | 3 | `support_worker` |

Everyone is seeded `fulltime` and active. Per-person overrides (`type: 'bank'`,
`role: 'senior_staff'`, custom skills) can be added to any row of the `STAFF` array.

### Passwords

Every created account gets its **own 14-character random password** from Node's CSPRNG
(`crypto.randomInt`), guaranteed to mix upper/lower/digit/symbol and excluding ambiguous
glyphs (`0/O`, `1/l/I`) since staff type them by hand.

Passwords are **never printed to the terminal**. They are written to

```
MyRotaProNode/scripts/output/staff-credentials-<timestamp>.csv   (mode 0600)
```

with columns `name,email,role,password`. The directory is gitignored.

**That CSV is the only copy** — the database stores just the bcrypt hash. Distribute the
credentials, tell staff to change them on first login, then delete it
(`shred -u scripts/output/staff-credentials-*.csv`). If a password is lost, issue a new
one with `--reset-passwords` rather than trying to recover it.

### Data handling

- **Phones** are converted to E.164 (`07592069404` → `+447592069404`); the User model's
  phone regex rejects a leading `0`.
- **Missing email**: Emmanuel Ebuka Mbadugha has no address in the sheet, so a
  placeholder `emmanuel.ebuka.mbadugha@rcsrota.co.uk` is generated (email is the unique
  login key). Update it in-app once the real address is known.
- **Homes are not assigned** — the sheet has no home column, so `homes[]` is empty and
  managers allocate staff in the app.

### Usage

```bash
cd MyRotaProNode

# 1. validate + preview — no writes, no passwords generated
npm run seed-staff -- --dry-run

# 2. seed the database named in .env.production
npm run seed-staff -- --confirm

# issue new passwords to accounts that already exist
npm run seed-staff -- --confirm --reset-passwords

# target a different environment
npm run seed-staff -- --confirm --env-file=.env.staging
```

### Safety

- **Non-destructive**: nothing is deleted or wiped. Matching is by email.
- **Idempotent**: re-running reports `unchanged` for untouched records and deletes the
  empty credentials file it opened.
- **Refuses to write** without `--confirm` (or `SEED_CONFIRM=1`).
- **Validates first**: every email/phone is checked against the model's regexes and for
  duplicates before a single document is written, so a bad row can't half-seed the list.
- **Credential-safe ordering**: each password is flushed to the 0600 CSV *before* the
  user is saved, so a crash can't leave an account whose password nobody holds.
- Existing users keep their password (unless `--reset-passwords`), homes and hours; only
  name/phone/role/type are refreshed from the sheet.

---

## `exportCredentialsPdf.js` — printable credentials sheet

Renders a `staff-credentials-*.csv` from the seed script into an A4 PDF table
(`#`, name, email, password) for handing out initial logins. Passwords are set in a
monospace face so `O`/`0`-style confusion can't creep in when they are typed.

```bash
cd MyRotaProNode
npm run export-credentials                       # newest CSV in scripts/output
npm run export-credentials -- --csv=<path.csv>   # a specific CSV
npm run export-credentials -- --out=<path.pdf>   # a specific destination
```

The PDF lands next to its CSV in `scripts/output/` (gitignored) at mode 0600, carries a
CONFIDENTIAL banner and a per-page footer, and repeats the table header on every page.

**It contains plain-text passwords, exactly like the CSV.** Distribute the logins, then
destroy both files:

```bash
shred -u scripts/output/staff-credentials-*
```
