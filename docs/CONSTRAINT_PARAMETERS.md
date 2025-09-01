# Hours Constraint Parameters

This document outlines the updated constraint parameters for managing staff hours based on employment type, including the new shift priority system.

## Minimum Hours Per Week (Hard Constraint)

**Constraint Type:** `min_hours_per_week`  
**Category:** Hard (Weight: 800)  
**Description:** Staff must meet minimum weekly hours based on employment type

### Parameters:
```json
{
  "fulltime": 38,    // Full-time staff must work at least 38 hours/week
  "parttime": 0,     // Part-time staff have no minimum requirement
  "bank": 0          // Bank staff have no minimum requirement
}
```

### Examples:
- **Fulltime staff working 35 hours** → ❌ **VIOLATION** (3 hours below minimum)
- **Fulltime staff working 38 hours** → ✅ **COMPLIANT**
- **Part-time staff working 0 hours** → ✅ **COMPLIANT** (no minimum requirement)
- **Bank staff working 0 hours** → ✅ **COMPLIANT** (no minimum requirement)

## Maximum Hours Per Week (Soft Constraint)

**Constraint Type:** `max_hours_per_week`  
**Category:** Soft (Weight: 100)  
**Description:** Staff should not exceed maximum weekly hours based on employment type

### Parameters:
```json
{
  "fulltime": 80,    // Full-time staff cannot exceed 80 hours/week
  "parttime": 20,    // Part-time staff cannot exceed 20 hours/week
  "bank": 20,        // Bank staff cannot exceed 20 hours/week
  "overtime_threshold": 40,
  "overtime_penalty_multiplier": 1.5
}
```

### Examples:
- **Fulltime staff working 85 hours** → ❌ **VIOLATION** (5 hours above maximum)
- **Fulltime staff working 80 hours** → ✅ **COMPLIANT**
- **Part-time staff working 25 hours** → ❌ **VIOLATION** (5 hours above maximum)
- **Bank staff working 25 hours** → ❌ **VIOLATION** (5 hours above maximum)

## Shift Priority by Employment Type (Soft Constraint)

**Constraint Type:** `shift_priority`  
**Category:** Soft (Weight: 50)  
**Description:** Prioritize scheduling for certain employment types (part-time over bank staff)

### Parameters:
```json
{
  "priority_order": ["fulltime", "parttime", "bank"],
  "parttime_over_bank_boost": 1.5,
  "fulltime_over_parttime_boost": 1.2
}
```

### Priority System:
1. **Fulltime staff** get highest priority for shifts
2. **Part-time staff** get priority over bank staff (1.5x boost when bank staff are available)
3. **Bank staff** get lowest priority but can still be assigned shifts

### Examples:
- **When assigning a shift**: Part-time workers will be preferred over bank staff
- **Priority scores**: Fulltime (1.0) > Part-time (0.5) > Bank (0.33)
- **Boosted scores**: Part-time with bank available = 0.5 × 1.5 = 0.75

## Employment Type Compliance (Soft Constraint)

**Constraint Type:** `employment_type_compliance`  
**Category:** Soft (Weight: 60)  
**Description:** Ensure scheduling respects employment type constraints

### Parameters:
```json
{
  "fulltime_preference": 0.8,    // Full-time staff should work ~80% of target hours
  "parttime_preference": 0.6,    // Part-time staff should work ~60% of target hours
  "bank_preference": 0.4         // Bank staff should work ~40% of target hours
}
```

## Penalty Calculation

### Minimum Hours Violation:
```
Penalty = Base Penalty × (1 + Deficit Hours / 10)
```

### Maximum Hours Violation:
```
Penalty = Base Penalty × (1 + Excess Hours / 10) × Overtime Multiplier
```

### Overtime Multiplier:
- Applied when hours exceed `overtime_threshold`
- Default multiplier: 1.5x
- Helps discourage excessive overtime

## Testing

Run the updated test script to verify constraint behavior:
```bash
cd MyRotaProNode
node scripts/testHoursConstraints.js
```

## Expected Test Results

| Employment Type | Hours | Expected Violation |
|----------------|-------|-------------------|
| Fulltime       | 35    | min_hours_per_week |
| Fulltime       | 85    | max_hours_per_week |
| Fulltime       | 40    | None              |
| Part-time      | 0     | None              |
| Part-time      | 25    | max_hours_per_week |
| Part-time      | 20    | None              |
| Bank           | 0     | None              |
| Bank           | 25    | max_hours_per_week |

## Shift Priority Testing

The test script also demonstrates the shift priority system:
- **Fulltime staff** get highest priority scores
- **Part-time staff** get boosted scores when bank staff are available
- **Bank staff** get lowest priority scores

This ensures that when scheduling shifts, part-time workers are preferred over bank staff, while full-time workers maintain the highest priority for critical shifts.
