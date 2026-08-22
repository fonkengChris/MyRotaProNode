/**
 * Web Push delivery. Sends notifications to a user's subscribed devices (phone/computer)
 * via the browsers' push services using VAPID. No-ops (with a warning) when VAPID keys
 * are not configured, so the app keeps working without push set up.
 */
const webpush = require('web-push');
const { getConfig } = require('../config/env');
const PushSubscription = require('../models/PushSubscription');

let configured = false;
let warnedOnce = false;

function ensureConfigured() {
  if (configured) return true;
  const { publicKey, privateKey, subject } = getConfig().push || {};
  if (!publicKey || !privateKey) {
    if (!warnedOnce) {
      console.warn('[pushService] VAPID keys not configured — skipping push delivery.');
      warnedOnce = true;
    }
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

/**
 * Send a push notification to every device subscribed by a user.
 * Dead subscriptions (404/410) are pruned automatically.
 * @param {string|ObjectId} userId
 * @param {{ title: string, body: string, url?: string, tag?: string }} payload
 */
async function sendPushToUser(userId, payload) {
  if (!userId || !ensureConfigured()) return;

  const subscriptions = await PushSubscription.find({ user_id: userId });
  if (!subscriptions.length) return;

  const data = JSON.stringify(payload);

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          data
        );
      } catch (error) {
        // 404/410 mean the subscription is gone — remove it so we stop trying.
        if (error.statusCode === 404 || error.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        } else {
          console.error('[pushService] Push send failed:', error.statusCode || error.message);
        }
      }
    })
  );
}

module.exports = { sendPushToUser };
