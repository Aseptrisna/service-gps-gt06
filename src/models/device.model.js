const mongoose = require('mongoose');

// Matches the existing backend Device schema (collection: devices)
const schema = new mongoose.Schema(
  {
    imei:         { type: String, required: true, unique: true },
    device_name:  { type: String, required: true },
    vehicle_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    phone_number: { type: String, default: null },
    status:       { type: String, enum: ['online', 'offline'], default: 'offline' },
    last_seen:    { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Device', schema);
