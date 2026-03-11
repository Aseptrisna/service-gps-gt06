const mongoose = require('mongoose');
const config = require('./config');
const log = require('./logger');

async function connect() {
  mongoose.connection.on('connected', () => log.info('[DB] MongoDB connected'));
  mongoose.connection.on('error', (err) => log.error('[DB] MongoDB error:', err.message));
  mongoose.connection.on('disconnected', () => log.warn('[DB] MongoDB disconnected'));

  await mongoose.connect(config.mongodb.uri);
}

module.exports = { connect };
