const mongoose = require('mongoose');

// Matches the existing backend GpsData schema (collection: gps_data)
const schema = new mongoose.Schema(
  {
    imei:       { type: String, required: true, index: true },
    vehicle_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    latitude:   { type: Number, required: true },
    longitude:  { type: Number, required: true },
    speed:      { type: Number, default: 0 },
    course:     { type: Number, default: 0 },
    altitude:   { type: Number, default: 0 },
    timestamp:  { type: Date, default: Date.now },
    raw_data:   { type: Object, default: null },
  },
  { timestamps: true, collection: 'gps_data' },
);

schema.index({ imei: 1, timestamp: -1 });

module.exports = mongoose.model('GpsData', schema);
