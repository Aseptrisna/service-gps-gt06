require('dotenv').config();

module.exports = {
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/fleet_monitoring',
  },
  tcp: {
    host: process.env.TCP_HOST || '0.0.0.0',
    port: parseInt(process.env.TCP_PORT || '8090', 10),
  },
  ws: {
    port: parseInt(process.env.WS_PORT || '8091', 10),
    corsOrigin: process.env.WS_CORS_ORIGIN || '*',
  },
};
