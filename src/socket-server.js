const http = require('http');
const { Server } = require('socket.io');
const config = require('./config');
const log = require('./logger');

function createSocketServer() {
  const httpServer = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'trackpro-gps-worker', status: 'running' }));
  });

  const ioServer = new Server(httpServer, {
    cors: {
      origin: config.ws.corsOrigin,
      methods: ['GET', 'POST'],
    },
  });

  // Use the same /tracking namespace as the backend
  const nsp = ioServer.of('/tracking');

  nsp.on('connection', (socket) => {
    log.info(`[WS] Client connected: ${socket.id}`);

    socket.on('subscribe_vehicle', (vehicleId) => {
      socket.join(`vehicle_${vehicleId}`);
      log.debug(`[WS] ${socket.id} → subscribe vehicle_${vehicleId}`);
    });

    socket.on('unsubscribe_vehicle', (vehicleId) => {
      socket.leave(`vehicle_${vehicleId}`);
      log.debug(`[WS] ${socket.id} → unsubscribe vehicle_${vehicleId}`);
    });

    socket.on('subscribe_all', () => {
      socket.join('all_vehicles');
      log.debug(`[WS] ${socket.id} → subscribe all_vehicles`);
    });

    socket.on('disconnect', () => {
      log.info(`[WS] Client disconnected: ${socket.id}`);
    });
  });

  httpServer.listen(config.ws.port, () => {
    log.info(`[WS] Listening on port ${config.ws.port} (namespace: /tracking)`);
  });

  return nsp;
}

module.exports = { createSocketServer };
