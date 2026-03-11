const log = require('./logger');
const config = require('./config');
const { connect } = require('./database');
const { createTcpServer, setSocketIO } = require('./tcp-server');
const { createSocketServer } = require('./socket-server');

async function main() {
  log.info('══════════════════════════════════════════');
  log.info('  TrackPro GPS Worker v1.0.0');
  log.info('  GT06 GPS Tracker Receiver');
  log.info('══════════════════════════════════════════');

  // 1. Connect to MongoDB
  await connect();

  // 2. Start WebSocket server for real-time broadcasts
  const socketIO = createSocketServer();
  setSocketIO(socketIO);

  // 3. Start TCP server for GT06 device connections
  createTcpServer();

  log.info('');
  log.info('Worker ready — waiting for GPS tracker connections');
  log.info(`  TCP : ${config.tcp.host}:${config.tcp.port}`);
  log.info(`  WS  : ws://0.0.0.0:${config.ws.port}/tracking`);
  log.info(`  DB  : ${config.mongodb.uri}`);
}

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    log.info(`Received ${sig}, shutting down...`);
    process.exit(0);
  });
});

process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection:', err);
});

main().catch((err) => {
  log.error('Fatal:', err);
  process.exit(1);
});
