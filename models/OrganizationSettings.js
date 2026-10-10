const mongoose = require('mongoose');

// A single, company-wide document holding information that staff need but that
// doesn't belong to any one home: help/emergency phone numbers and the
// shift-start checklist ("useful tips on shift"). There is only ever one of
// these documents (a singleton) — use `OrganizationSettings.getSettings()` to
// read it, which seeds sensible defaults on first access.

const contactSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true },
  number: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' }
}, { _id: false });

const organizationSettingsSchema = new mongoose.Schema({
  // General company/admin numbers staff can call for help (office, out-of-hours,
  // on-call manager, safeguarding lead, etc.).
  company_contacts: {
    type: [contactSchema],
    default: []
  },
  // Emergency numbers, shown with a distinct (danger) treatment on the profile.
  emergency_contacts: {
    type: [contactSchema],
    default: []
  },
  // Shift-start checklist grouped by section (from the Supported Living
  // Shift-Start Checklist). Each section is a list of tip lines.
  shift_tips: {
    core: { type: [String], default: [] },
    day: { type: [String], default: [] },
    night: { type: [String], default: [] },
    escalation: { type: [String], default: [] }
  },
  // Recurring key-worker responsibilities shown on the Key Worker Home page,
  // grouped by how often they come round. Static prompts, not tracked tasks.
  key_worker_tasks: {
    daily: { type: [String], default: [] },
    weekly: { type: [String], default: [] },
    monthly: { type: [String], default: [] }
  },
  updated_at: { type: Date, default: Date.now },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Defaults seeded on first access. Contacts are labelled placeholders so admins
// know the shape; shift tips are taken verbatim from the shift-start checklist.
const DEFAULTS = {
  company_contacts: [
    { label: 'Head Office', number: '', notes: 'Update me' },
    { label: 'Out of Hours', number: '', notes: 'Update me' },
    { label: 'On-call Manager', number: '', notes: 'Update me' },
    { label: 'Safeguarding Lead', number: '', notes: 'Update me' }
  ],
  emergency_contacts: [
    { label: 'Emergency Services', number: '999', notes: 'Police, Fire, Ambulance' },
    { label: 'NHS 111', number: '111', notes: 'Non-emergency medical advice' },
    { label: 'Local Authority Duty', number: '', notes: 'Update me' }
  ],
  shift_tips: {
    core: [
      'Read communication book / digital logs',
      'Receive verbal handover (if available)',
      'Note incidents / safeguarding concerns',
      'Check changes in health or behaviour',
      'Confirm all service users are present',
      'Observe wellbeing (physical & emotional)',
      'Identify any immediate risks',
      'Review MAR charts (medications due)',
      'Check for missed medications',
      'Count controlled drugs (if required)',
      'Ensure medication is stored safely',
      'Check environment safety — fire exits clear, no hazards (spillages, damage)',
      'Check availability of petty-cash',
      "Check availability of keys (access) to service users' rooms (emergencies)",
      'Access care plans & risk assessments',
      'Check for any updates to support plans'
    ],
    day: [
      'Administer morning medication',
      'Support meals / nutrition',
      'Check appointments for the day',
      'Confirm activities / outings planned',
      'Review risk assessments for outings',
      'Review individual care goals',
      'Provide person-centred support',
      'Prepare for visitors / professionals',
      'Maintain confidentiality',
      'Check food stock & meal plans',
      'Report maintenance issues',
      'Complete cleaning tasks'
    ],
    night: [
      'Confirm all service users are in the building',
      'Check sleeping arrangements are safe',
      'Follow observation schedule',
      'Monitor health overnight (breathing, seizures, distress)',
      'Ensure doors & windows are locked',
      'Check security systems working',
      'Administer night medication (if required)',
      'Monitor PRN medication effectiveness',
      'Ensure safe environment (lighting, clear walkways)',
      'Complete documentation',
      'Record any concerns clearly',
      'Prepare handover for day staff'
    ],
    escalation: [
      'Report immediately — medication errors, missing persons, safeguarding concerns, health deterioration',
      'Record all incidents accurately',
      'Follow service policies at all times'
    ]
  },
  key_worker_tasks: {
    daily: [
      'Check in on each of your service users, in person or through the house team',
      'Read daily notes and handover for your service users',
      'Follow up incidents, safeguarding concerns and changes in health or behaviour',
      'Check MAR charts and medication records for your service users',
      'Reply to messages from families and professionals'
    ],
    weekly: [
      'Hold 1:1 support sessions with each service user, in line with their allocated hours',
      'Review progress against support-plan goals',
      "Audit staff records in your service users' homes: training, supervision, DBS and right-to-work",
      "Check the rota covers each service user's allocated support hours",
      'Plan activities and appointments for the coming week',
      'Check personal finance and petty-cash records'
    ],
    monthly: [
      'Review and update support plans and risk assessments',
      'Write a monthly key-worker summary for each service user',
      "Check in with, or supervise, staff in your service users' homes",
      'Audit the quality of care records: daily notes and incident forms',
      'Review health appointments: GP, dentist, optician and annual health check',
      'Liaise with families, social workers and commissioners'
    ]
  }
};

// Returns the single settings document, creating it (seeded with DEFAULTS) if it
// doesn't exist yet.
organizationSettingsSchema.statics.getSettings = async function () {
  const raw = await this.findOne().lean();
  if (!raw) {
    return this.create(DEFAULTS);
  }
  // Documents created before key_worker_tasks existed get the defaults once. Checked
  // on the raw doc because hydration fills in empty arrays, which would otherwise be
  // indistinguishable from an admin deliberately clearing a section.
  if (raw.key_worker_tasks === undefined) {
    await this.updateOne({ _id: raw._id }, { $set: { key_worker_tasks: DEFAULTS.key_worker_tasks } });
  }
  return this.findById(raw._id);
};

organizationSettingsSchema.statics.DEFAULTS = DEFAULTS;

module.exports = mongoose.model('OrganizationSettings', organizationSettingsSchema);
