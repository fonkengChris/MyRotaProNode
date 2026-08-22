const mongoose = require('mongoose');

/**
 * A Web Push subscription for a user's device/browser. A user may have several
 * (phone, laptop, etc.). `endpoint` is globally unique per subscription.
 */
const pushSubscriptionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  endpoint: {
    type: String,
    required: true,
    unique: true,
  },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  user_agent: { type: String },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
