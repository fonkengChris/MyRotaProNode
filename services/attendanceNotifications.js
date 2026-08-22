/**
 * Delivers attendance reminders/escalations over two channels:
 *   1. In-app: creates Message documents (the existing 1:1 messaging the frontend polls).
 *   2. Web Push: best-effort via services/pushService.js so recipients get a native
 *      notification on their phone/computer (no-op when VAPID unconfigured).
 *
 * The Message model requires real from/to users, so:
 *   - staff reminder  -> from a manager of the home, to the late staff member.
 *   - escalation      -> from the late staff member, to each manager/admin.
 */
const User = require('../models/User');
const Message = require('../models/Message');
const { sendPushToUser } = require('./pushService');

function homeLabel(shift) {
  const h = shift.home_id;
  if (h && typeof h === 'object' && h.name) return h.name;
  return 'your home';
}

// Managers/admins who should receive escalations for a given home.
async function getManagementRecipients(homeId) {
  return User.find({
    is_active: true,
    $or: [
      { role: 'admin' },
      { role: 'home_manager', 'homes.home_id': homeId },
    ],
  }).select('name email role');
}

async function safeSendMessage(fromId, toId, body) {
  if (!fromId || !toId) return;
  try {
    await Message.create({ from_user_id: fromId, to_user_id: toId, body });
  } catch (error) {
    console.error('[attendanceNotifications] Failed to create in-app message:', error.message);
  }
}

/**
 * 5-minute reminder to the late staff member.
 * @param {object} shift - Shift doc (home_id may be populated with a name).
 * @param {object} staffUser - populated user for the late assignment (name, email).
 */
async function notifyLateStaff(shift, staffUser) {
  if (!staffUser) return;

  const label = homeLabel(shift);
  const body = `Reminder: your shift at ${label} started at ${shift.start_time} and you haven't clocked in yet. Please clock in as soon as you arrive.`;

  // Use a manager/admin of the home as the in-app sender.
  const managers = await getManagementRecipients(shift.home_id && shift.home_id._id ? shift.home_id._id : shift.home_id);
  const sender = managers.find((m) => m.role === 'home_manager') || managers[0];

  await safeSendMessage(sender && sender._id, staffUser._id, body);

  await sendPushToUser(staffUser._id, {
    title: 'Clock-in reminder',
    body,
    url: '/dashboard',
    tag: `clock-in-${shift._id}`,
  });
}

/**
 * 15-minute escalation to management (home managers + all admins).
 * @param {object} shift - Shift doc (home_id may be populated with a name).
 * @param {object} staffUser - populated user for the late assignment.
 */
async function notifyManagement(shift, staffUser) {
  const label = homeLabel(shift);
  const staffName = staffUser && staffUser.name ? staffUser.name : 'A staff member';
  const body = `${staffName} has not clocked in 15 minutes after their ${shift.start_time} shift at ${label} (${shift.date}). Please follow up.`;

  const recipients = await getManagementRecipients(shift.home_id && shift.home_id._id ? shift.home_id._id : shift.home_id);

  for (const recipient of recipients) {
    // Don't message the late staff member even if they somehow hold a management role.
    if (staffUser && recipient._id.toString() === staffUser._id.toString()) continue;

    await safeSendMessage(staffUser && staffUser._id, recipient._id, body);

    await sendPushToUser(recipient._id, {
      title: `Missed clock-in — ${staffName}`,
      body,
      url: '/dashboard',
      tag: `escalation-${shift._id}`,
    });
  }
}

module.exports = { notifyLateStaff, notifyManagement, getManagementRecipients };
