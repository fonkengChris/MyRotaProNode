const mongoose = require('mongoose');

// A person supported by the organisation. Each service user lives in one home and
// is supported by one or more key workers. Key workers aren't attached to houses
// directly; instead they gain access to the homes their service users live in
// (see getUserHomeIds in middleware/auth.js).
const serviceUserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Service user name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters']
  },
  home_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Home',
    required: [true, 'Home is required']
  },
  key_worker_ids: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // Allocated 1:1 support hours per week; differs per person. Informational only.
  one_to_one_hours_per_week: {
    type: Number,
    min: [0, 'Hours cannot be negative'],
    max: [168, 'Hours cannot exceed 168 per week']
  },
  notes: {
    type: String,
    trim: true,
    maxlength: [1000, 'Notes cannot exceed 1000 characters']
  },
  is_active: {
    type: Boolean,
    default: true
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes for performance
serviceUserSchema.index({ key_worker_ids: 1, is_active: 1 });
serviceUserSchema.index({ home_id: 1 });

// Home id strings a key worker can reach through their active service users.
serviceUserSchema.statics.getHomeIdsForKeyWorker = async function(userId) {
  const homeIds = await this.distinct('home_id', { key_worker_ids: userId, is_active: true });
  return homeIds.map(id => id.toString());
};

// Key worker ids supporting an active service user in the given home.
serviceUserSchema.statics.getKeyWorkerIdsForHome = async function(homeId) {
  return this.distinct('key_worker_ids', { home_id: homeId, is_active: true });
};

// Ensure virtual fields are serialized
serviceUserSchema.set('toJSON', { virtuals: true });
serviceUserSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ServiceUser', serviceUserSchema);
