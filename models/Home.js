const mongoose = require('mongoose');

const homeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Home name is required'],
    trim: true,
    maxlength: [100, 'Home name cannot exceed 100 characters']
  },
  location: {
    address: {
      type: String,
      required: [true, 'Address is required'],
      trim: true
    },
    city: {
      type: String,
      required: [true, 'City is required'],
      trim: true
    },
    postcode: {
      type: String,
      required: [true, 'Postcode is required'],
      trim: true
    },
    coordinates: {
      lat: Number,
      lng: Number
    }
  },
  manager_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false // Made optional to allow initial setup
  },
  contact_info: {
    phone: {
      type: String,
      required: [true, 'Contact phone is required'],
      trim: true
    },
    email: {
      type: String,
      required: [true, 'Contact email is required'],
      lowercase: true,
      trim: true
    }
  },
  capacity: {
    type: Number,
    required: [true, 'Capacity is required'],
    min: [1, 'Capacity must be at least 1'],
    max: [1000, 'Capacity cannot exceed 1000']
  },
  operating_hours: {
    start: {
      type: String,
      default: '07:00',
      match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
    },
    end: {
      type: String,
      default: '22:00',
      match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Invalid time format (HH:MM)']
    }
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
homeSchema.index({ name: 1 });
homeSchema.index({ 'location.city': 1 });
homeSchema.index({ manager_id: 1 });
homeSchema.index({ is_active: 1 });

// Virtual for home info (excluding sensitive data)
homeSchema.virtual('publicInfo').get(function() {
  return {
    id: this._id,
    name: this.name,
    location: this.location,
    contact_info: this.contact_info,
    capacity: this.capacity,
    operating_hours: this.operating_hours,
    is_active: this.is_active
  };
});

// Method to get active services
homeSchema.methods.getActiveServices = async function() {
  const Service = mongoose.model('Service');
  return await Service.find({ 
    home_ids: this._id, 
    is_active: true 
  });
};

// Method to check if home is operational at given time
homeSchema.methods.isOperational = function(time) {
  const [hours, minutes] = time.split(':').map(Number);
  const [startHours, startMinutes] = this.operating_hours.start.split(':').map(Number);
  const [endHours, endMinutes] = this.operating_hours.end.split(':').map(Number);
  
  const timeInMinutes = hours * 60 + minutes;
  const startInMinutes = startHours * 60 + startMinutes;
  const endInMinutes = endHours * 60 + endMinutes;
  
  return timeInMinutes >= startInMinutes && timeInMinutes <= endInMinutes;
};

// Ensure virtual fields are serialized
homeSchema.set('toJSON', { virtuals: true });
homeSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Home', homeSchema);
