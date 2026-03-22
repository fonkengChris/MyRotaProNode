const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    from_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    to_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    body: {
      type: String,
      required: [true, 'Message body is required'],
      trim: true,
      maxlength: [8000, 'Message is too long'],
    },
    read_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: false },
  }
);

messageSchema.index({ from_user_id: 1, to_user_id: 1, created_at: -1 });
messageSchema.index({ to_user_id: 1, read_at: 1 });

module.exports = mongoose.model('Message', messageSchema);
