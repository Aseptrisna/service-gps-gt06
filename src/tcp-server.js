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
function handleConnection(client) {
  const gt06 = new Gt06();
  const addr = `${client.remoteAddress}:${client.remotePort}`;
  let currentImei = null;

  log.info(`[TCP] Connection from ${addr}`);

  // TCP keepalive to detect dead connections
  client.setKeepAlive(true, 30000);

  // Buffer for TCP fragmentation — GT06 packets may arrive in fragments
  let pendingBuffer = Buffer.alloc(0);

  client.on('data', async (data) => {
    log.info(`[TCP] Raw data from ${addr} (${data.length} bytes): ${data.toString('hex')}`);

    // Accumulate fragments
    pendingBuffer = Buffer.concat([pendingBuffer, data]);

    // Process complete packets from buffer
    while (pendingBuffer.length > 0) {
      // Check for valid GT06 header
      if (pendingBuffer[0] !== 0x78 && pendingBuffer[0] !== 0x79) {
        // Skip invalid bytes until we find a valid header
        const idx78 = pendingBuffer.indexOf(Buffer.from('7878', 'hex'));
        const idx79 = pendingBuffer.indexOf(Buffer.from('7979', 'hex'));
        let nextValid = -1;
        if (idx78 !== -1 && idx79 !== -1) nextValid = Math.min(idx78, idx79);
        else if (idx78 !== -1) nextValid = idx78;
        else if (idx79 !== -1) nextValid = idx79;

        if (nextValid === -1) {
          log.warn(`[TCP] Discarding ${pendingBuffer.length} bytes of non-GT06 data from ${addr}: ${pendingBuffer.toString('hex').substring(0, 40)}`);
          pendingBuffer = Buffer.alloc(0);
          break;
        }
        log.warn(`[TCP] Skipping ${nextValid} junk bytes from ${addr}`);
        pendingBuffer = pendingBuffer.slice(nextValid);
        continue;
      }

      // Determine packet length
      let packetLen;
      if (pendingBuffer[0] === 0x78 && pendingBuffer[1] === 0x78) {
        // Short header: [0x78, 0x78, length, ...data, crc, crc, 0x0d, 0x0a]
        if (pendingBuffer.length < 3) break; // need more data
        packetLen = pendingBuffer[2] + 5; // length byte + 2 header + 2 stop
      } else if (pendingBuffer[0] === 0x79 && pendingBuffer[1] === 0x79) {
        // Long header: [0x79, 0x79, lengthHi, lengthLo, ...data, crc, crc, 0x0d, 0x0a]
        if (pendingBuffer.length < 4) break; // need more data
        packetLen = pendingBuffer.readUInt16BE(2) + 6; // 2-byte length + 2 header + 2 stop
      } else {
        pendingBuffer = pendingBuffer.slice(1);
        continue;
      }

      // Wait for full packet
      if (pendingBuffer.length < packetLen) {
        log.debug(`[TCP] Waiting for more data: have ${pendingBuffer.length}/${packetLen} bytes from ${addr}`);
        break;
      }

      // Extract one complete packet
      const packet = pendingBuffer.slice(0, packetLen);
      pendingBuffer = pendingBuffer.slice(packetLen);

      // Parse the packet
      try {
        gt06.parse(packet);
      } catch (e) {
        log.error(`[GPS] Parse error (${addr}): ${e.error || e.message || JSON.stringify(e)}`);
        continue;
      }

      // Send ACK response if needed (login, status)
      if (gt06.expectsResponse && gt06.responseMsg) {
        client.write(gt06.responseMsg);
        log.debug(`[TCP] ACK sent to ${addr}`);
      }

      // Process all messages in buffer (same pattern as original working code)
      const messagePromises = gt06.msgBuffer.map(async (msg) => {
        const eventType = msg.event?.string || 'unknown';
        currentImei = msg.imei ? String(msg.imei) : currentImei;

        switch (eventType) {
          case 'login':
            log.info(`[GPS] Login  IMEI=${currentImei} (${addr})`);
            await onLogin(currentImei);
            break;

          case 'location':
            log.info(`[GPS] Loc    IMEI=${currentImei}  lat=${msg.lat} lon=${msg.lon} spd=${msg.speed}`);
            await onLocation(currentImei, msg);
            break;

          case 'status':
            log.info(`[GPS] Status IMEI=${currentImei}  batt=${msg.voltageLevel} gsm=${msg.gsmSigStrength}`);
            await onStatus(currentImei, msg);
            break;

          case 'alarm':
            log.warn(`[GPS] Alarm  IMEI=${currentImei}  type=${parseAlarmType(msg.terminalInfo)}`);
            await onAlarm(currentImei, msg);
            break;

          default:
            log.debug(`[GPS] Unhandled event "${eventType}" from ${addr}`);
        }
      });

      await Promise.all(messagePromises);
      gt06.clearMsgBuffer();
    }
  });

  client.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      log.error(`[TCP] Error ${addr}:`, err.message);
    }
  });

  client.on('end', () => {
    log.info(`[TCP] Disconnected ${addr} (IMEI: ${currentImei || '?'})`);
  });

  client.on('close', () => {
    log.info(`[TCP] Closed  ${addr} (IMEI: ${currentImei || '?'})`);
    if (currentImei) {
      Device.findOneAndUpdate(
        { imei: currentImei },
        { status: 'offline', last_seen: new Date() },
      ).catch((e) => log.error('[DB] Offline update failed:', e.message));
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
