const net = require('net');
const Gt06 = require('./lib/gt06');
const config = require('./config');
const log = require('./logger');
const GpsData = require('./models/gps-data.model');
const Device = require('./models/device.model');

let io = null; // Socket.IO namespace reference

function setSocketIO(socketIO) {
  io = socketIO;
}

// Parse alarm type from terminal info byte (same logic as gt06 library's status parser)
function parseAlarmType(terminalInfoByte) {
  const alarm = (terminalInfoByte & 0x38) >> 3;
  switch (alarm) {
    case 1: return 'shock';
    case 2: return 'power_cut';
    case 3: return 'low_battery';
    case 4: return 'sos';
    default: return 'normal';
  }
}

// ─── Connection handler ─────────────────────────────────────────────────────
function handleConnection(socket) {
  const tracker = new Gt06();
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  let currentImei = null;

  log.info(`[TCP] Connection from ${addr}`);

  // 5-minute inactivity timeout
  socket.setTimeout(5 * 60 * 1000);

  socket.on('data', async (data) => {
    try {
      tracker.parse(data);

      // Send response if the protocol requires it (login, status)
      if (tracker.expectsResponse && tracker.responseMsg) {
        socket.write(tracker.responseMsg);
      }

      currentImei = tracker.imei ? String(tracker.imei) : currentImei;
      const event = tracker.event?.string || 'unknown';

      switch (event) {
        case 'login':
          log.info(`[GPS] Login  IMEI=${currentImei} (${addr})`);
          await onLogin(currentImei);
          break;

        case 'location':
          log.info(`[GPS] Loc    IMEI=${currentImei}  lat=${tracker.lat} lon=${tracker.lon} spd=${tracker.speed}`);
          await onLocation(currentImei, tracker);
          break;

        case 'status':
          log.info(`[GPS] Status IMEI=${currentImei}  batt=${tracker.voltageLevel} gsm=${tracker.gsmSigStrength}`);
          await onStatus(currentImei, tracker);
          break;

        case 'alarm':
          log.warn(`[GPS] Alarm  IMEI=${currentImei}  type=${parseAlarmType(tracker.terminalInfo)}`);
          await onAlarm(currentImei, tracker);
          break;

        default:
          log.debug(`[GPS] Unknown event "${event}" from ${addr}`);
      }
    } catch (err) {
      log.error(`[GPS] Parse error (${addr}):`, err.error || err.message || err);
    }
  });

  socket.on('timeout', () => {
    log.warn(`[TCP] Timeout ${addr} (IMEI: ${currentImei || '?'})`);
    socket.destroy();
  });

  socket.on('close', () => {
    log.info(`[TCP] Closed  ${addr} (IMEI: ${currentImei || '?'})`);
    if (currentImei) {
      Device.findOneAndUpdate(
        { imei: currentImei },
        { status: 'offline', last_seen: new Date() },
      ).catch((e) => log.error('[DB] Offline update failed:', e.message));
    }
  });

  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      log.error(`[TCP] Error ${addr}:`, err.message);
    }
  });
}

// ─── Event handlers ─────────────────────────────────────────────────────────
async function onLogin(imei) {
  try {
    const device = await Device.findOneAndUpdate(
      { imei },
      { status: 'online', last_seen: new Date() },
    );
    if (!device) {
      log.warn(`[GPS] Unknown device IMEI=${imei} — not registered in database`);
    }
  } catch (e) {
    log.error('[DB] Login error:', e.message);
  }
}

async function onLocation(imei, t) {
  try {
    const device = await Device.findOneAndUpdate(
      { imei },
      { status: 'online', last_seen: new Date() },
      { new: true },
    );

    const record = {
      imei,
      vehicle_id: device?.vehicle_id || null,
      latitude: t.lat,
      longitude: t.lon,
      speed: t.speed || 0,
      course: t.course || 0,
      altitude: 0,
      timestamp: t.fixTime ? new Date(t.fixTime) : new Date(),
      raw_data: {
        fixTime: t.fixTime,
        fixTimestamp: t.fixTimestamp,
        satCnt: t.satCnt,
        satCntActive: t.satCntActive,
        realTimeGps: t.realTimeGps,
        gpsPositioned: t.gpsPositioned,
        mcc: t.mcc,
        mnc: t.mnc,
        lac: t.lac,
        cellId: t.cellId,
        speedUnit: t.speedUnit,
      },
    };

    const saved = await GpsData.create(record);

    // Broadcast to WebSocket clients
    if (io) {
      const payload = {
        _id: saved._id,
        imei,
        vehicle_id: device?.vehicle_id?.toString() || null,
        latitude: t.lat,
        longitude: t.lon,
        speed: t.speed || 0,
        course: t.course || 0,
        timestamp: record.timestamp,
      };

      io.to('all_vehicles').emit('location_update', payload);

      if (device?.vehicle_id) {
        io.to(`vehicle_${device.vehicle_id}`).emit('vehicle_location', payload);
      }
    }
  } catch (e) {
    log.error('[DB] Location save error:', e.message);
  }
}

async function onStatus(imei, t) {
  try {
    await Device.findOneAndUpdate(
      { imei },
      { status: 'online', last_seen: new Date() },
    );

    if (io) {
      io.to('all_vehicles').emit('device_status', {
        imei,
        terminalInfo: t.terminalInfo,
        voltageLevel: t.voltageLevel,
        gsmSigStrength: t.gsmSigStrength,
        timestamp: new Date(),
      });
    }
  } catch (e) {
    log.error('[DB] Status update error:', e.message);
  }
}

async function onAlarm(imei, t) {
  try {
    const device = await Device.findOneAndUpdate(
      { imei },
      { status: 'online', last_seen: new Date() },
      { new: true },
    );

    const alarmType = typeof t.terminalInfo === 'number'
      ? parseAlarmType(t.terminalInfo)
      : t.terminalInfo?.alarmType || 'unknown';

    // Alarm packets also carry location data — save it
    if (t.lat && t.lon) {
      await GpsData.create({
        imei,
        vehicle_id: device?.vehicle_id || null,
        latitude: t.lat,
        longitude: t.lon,
        speed: t.speed || 0,
        course: t.course || 0,
        timestamp: t.fixTime ? new Date(t.fixTime) : new Date(),
        raw_data: {
          type: 'alarm',
          alarmType,
          voltageLevel: t.voltageLevel,
          gpsSignal: t.gpsSignal,
        },
      });
    }

    if (io) {
      io.emit('alert', {
        imei,
        vehicle_id: device?.vehicle_id?.toString() || null,
        type: 'alarm',
        alarmType,
        latitude: t.lat,
        longitude: t.lon,
        timestamp: new Date(),
      });
    }
  } catch (e) {
    log.error('[DB] Alarm save error:', e.message);
  }
}

// ─── Start TCP server ───────────────────────────────────────────────────────
function createTcpServer() {
  const server = net.createServer(handleConnection);

  server.on('error', (err) => {
    log.error('[TCP] Server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      log.error(`[TCP] Port ${config.tcp.port} is already in use`);
      process.exit(1);
    }
  });

  server.listen(config.tcp.port, config.tcp.host, () => {
    log.info(`[TCP] Listening on ${config.tcp.host}:${config.tcp.port}`);
  });

  return server;
}

module.exports = { createTcpServer, setSocketIO };
