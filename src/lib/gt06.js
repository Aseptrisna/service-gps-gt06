// GT06 GPS Tracker Protocol Parser
// Based on gt06 npm package by Andy Hempel, fixed for Node.js 18+/22+
// Protocol docs: https://www.traccar.org/protocols/

'use strict';

const getCrc16 = require('./crc16');

// ─── Constructor ────────────────────────────────────────────────────────────
function Gt06() {
  this.msgBufferRaw = [];
  this.msgBuffer = [];
  this.imei = null;
}

// ─── Main parser ────────────────────────────────────────────────────────────
Gt06.prototype.parse = function (data) {
  this.msgBufferRaw.length = 0;
  const parsed = { expectsResponse: false };

  const headerType = checkHeader(data);
  if (!headerType) {
    throw { error: 'unknown message header', msg: data.toString('hex') };
  }

  this.msgBufferRaw = sliceMsgsInBuff(data).slice();

  this.msgBufferRaw.forEach((msg, idx) => {
    const event = selectEvent(msg, headerType);

    switch (event.number) {
      case 0x01: // login
        Object.assign(parsed, parseLogin(msg));
        parsed.expectsResponse = true;
        parsed.responseMsg = createResponse(msg, headerType);
        break;
      case 0x12: // location
        Object.assign(parsed, parseLocation(msg), { imei: this.imei });
        break;
      case 0x13: // status / heartbeat
        Object.assign(parsed, parseStatus(msg), { imei: this.imei });
        parsed.expectsResponse = true;
        parsed.responseMsg = createResponse(msg, headerType);
        break;
      case 0x16: // alarm
        Object.assign(parsed, parseAlarm(msg), { imei: this.imei });
        break;
      case 0x15: // string info (some GT06 variants)
        Object.assign(parsed, { imei: this.imei });
        break;
      default:
        throw { error: 'unknown message type', protocol: '0x' + event.number.toString(16), hex: msg.toString('hex') };
    }

    parsed.event = event;
    parsed.parseTime = Date.now();

    if (idx === this.msgBufferRaw.length - 1) {
      Object.assign(this, parsed);
    }
    this.msgBuffer.push({ ...parsed });
  });
};

Gt06.prototype.clearMsgBuffer = function () {
  this.msgBuffer.length = 0;
};

// ─── Header check (returns 'short'|'long'|false) ───────────────────────────
function checkHeader(data) {
  if (data.length < 2) return false;
  if (data[0] === 0x78 && data[1] === 0x78) return 'short';
  if (data[0] === 0x79 && data[1] === 0x79) return 'long';
  return false;
}

// ─── Event selector ─────────────────────────────────────────────────────────
function selectEvent(data, headerType) {
  const EVENTS = {
    0x01: 'login',
    0x12: 'location',
    0x13: 'status',
    0x15: 'string',
    0x16: 'alarm',
  };
  // short header: length at [2], protocol at [3]
  // long header: length at [2..3] (2 bytes), protocol at [4]
  const protocolIdx = headerType === 'long' ? 4 : 3;
  return { number: data[protocolIdx], string: EVENTS[data[protocolIdx]] || 'unknown' };
}

// ─── Login (0x01) ───────────────────────────────────────────────────────────
function parseLogin(data) {
  return {
    imei: parseInt(data.slice(4, 12).toString('hex'), 10),
    serialNumber: data.readUInt16BE(12),
  };
}

// ─── Location (0x12) ────────────────────────────────────────────────────────
function parseLocation(data) {
  const ds = {
    fixTime: data.slice(4, 10),
    quantity: data.readUInt8(10),
    lat: data.readUInt32BE(11),
    lon: data.readUInt32BE(15),
    speed: data.readUInt8(19),
    course: data.readUInt16BE(20),
    mcc: data.readUInt16BE(22),
    mnc: data.readUInt8(24),
    lac: data.readUInt16BE(25),
    cellId: parseInt(data.slice(27, 30).toString('hex'), 16),
    serialNr: data.readUInt16BE(30),
  };

  const fixDate = parseDatetime(ds.fixTime);

  return {
    fixTime: fixDate.toISOString(),
    fixTimestamp: fixDate.getTime() / 1000,
    satCnt: (ds.quantity & 0xf0) >> 4,
    satCntActive: ds.quantity & 0x0f,
    lat: decodeGt06Lat(ds.lat, ds.course),
    lon: decodeGt06Lon(ds.lon, ds.course),
    speed: ds.speed,
    speedUnit: 'km/h',
    realTimeGps: Boolean(ds.course & 0x2000),
    gpsPositioned: Boolean(ds.course & 0x1000),
    eastLongitude: !Boolean(ds.course & 0x0800),
    northLatitude: Boolean(ds.course & 0x0400),
    course: ds.course & 0x3ff,
    mcc: ds.mcc,
    mnc: ds.mnc,
    lac: ds.lac,
    cellId: ds.cellId,
    serialNr: ds.serialNr,
  };
}

// ─── Status / Heartbeat (0x13) ──────────────────────────────────────────────
function parseStatus(data) {
  const info = data.slice(4, 9);
  const termByte = info.readUInt8(0);
  const voltage = info.readUInt8(1);
  const gsm = info.readUInt8(2);

  const alarm = (termByte & 0x38) >> 3;
  const ALARM_TYPES = { 1: 'shock', 2: 'power_cut', 3: 'low_battery', 4: 'sos' };
  const VOLTAGE = {
    1: 'extremely_low', 2: 'very_low', 3: 'low',
    4: 'medium', 5: 'high', 6: 'very_high',
  };
  const GSM = { 1: 'extremely_weak', 2: 'very_weak', 3: 'good', 4: 'strong' };

  return {
    terminalInfo: {
      status: Boolean(termByte & 0x01),
      ignition: Boolean(termByte & 0x02),
      charging: Boolean(termByte & 0x04),
      alarmType: ALARM_TYPES[alarm] || 'normal',
      gpsTracking: Boolean(termByte & 0x40),
      relayState: Boolean(termByte & 0x80),
    },
    voltageLevel: VOLTAGE[voltage] || 'no_power',
    gsmSigStrength: GSM[gsm] || 'no_signal',
  };
}

// ─── Alarm (0x16) ───────────────────────────────────────────────────────────
function parseAlarm(data) {
  const ds = {
    fixTime: data.slice(4, 10),
    quantity: data.readUInt8(10),
    lat: data.readUInt32BE(11),
    lon: data.readUInt32BE(15),
    speed: data.readUInt8(19),
    course: data.readUInt16BE(20),
    mcc: data.readUInt16BE(22),
    mnc: data.readUInt8(24),
    lac: data.readUInt16BE(25),
    cellId: parseInt(data.slice(27, 30).toString('hex'), 16),
    terminalInfo: data.readUInt8(31),
    voltageLevel: data.readUInt8(32),
    gpsSignal: data.readUInt8(33),
    alarmLang: data.readUInt16BE(34),
    serialNr: data.readUInt16BE(36),
  };

  const fixDate = parseDatetime(ds.fixTime);

  return {
    fixTime: fixDate.toISOString(),
    fixTimestamp: fixDate.getTime() / 1000,
    satCnt: (ds.quantity & 0xf0) >> 4,
    satCntActive: ds.quantity & 0x0f,
    lat: decodeGt06Lat(ds.lat, ds.course),
    lon: decodeGt06Lon(ds.lon, ds.course),
    speed: ds.speed,
    speedUnit: 'km/h',
    realTimeGps: Boolean(ds.course & 0x2000),
    gpsPositioned: Boolean(ds.course & 0x1000),
    eastLongitude: !Boolean(ds.course & 0x0800),
    northLatitude: Boolean(ds.course & 0x0400),
    course: ds.course & 0x3ff,
    mcc: ds.mcc,
    mnc: ds.mnc,
    lac: ds.lac,
    cellId: ds.cellId,
    terminalInfo: ds.terminalInfo,
    voltageLevel: ds.voltageLevel,
    gpsSignal: ds.gpsSignal,
    alarmLang: ds.alarmLang,
    serialNr: ds.serialNr,
  };
}

// ─── Response builder ───────────────────────────────────────────────────────
function createResponse(data, headerType) {
  const resp = Buffer.from('787805FF0001d9dc0d0a', 'hex');
  const protocolIdx = headerType === 'long' ? 4 : 3;
  resp[3] = data[protocolIdx]; // protocol number from request
  appendCrc16(resp);
  return resp;
}

// ─── Utilities ──────────────────────────────────────────────────────────────
function parseDatetime(data) {
  return new Date(
    Date.UTC(data[0] + 2000, data[1] - 1, data[2], data[3], data[4], data[5]),
  );
}

function decodeGt06Lat(lat, course) {
  let latitude = lat / 60.0 / 30000.0;
  if (!(course & 0x0400)) latitude = -latitude;
  return Math.round(latitude * 1000000) / 1000000;
}

function decodeGt06Lon(lon, course) {
  let longitude = lon / 60.0 / 30000.0;
  if (course & 0x0800) longitude = -longitude;
  return Math.round(longitude * 1000000) / 1000000;
}

function appendCrc16(data) {
  data.writeUInt16BE(getCrc16(data.slice(2, 6)).readUInt16BE(0), data.length - 4);
}

function sliceMsgsInBuff(data) {
  const shortHeader = Buffer.from('7878', 'hex');
  const longHeader = Buffer.from('7979', 'hex');
  const msgArray = [];

  let pos = 0;
  while (pos < data.length) {
    let nextShort = data.indexOf(shortHeader, pos + 2);
    let nextLong = data.indexOf(longHeader, pos + 2);

    // Find earliest next message start
    let nextStart = -1;
    if (nextShort !== -1 && nextLong !== -1) nextStart = Math.min(nextShort, nextLong);
    else if (nextShort !== -1) nextStart = nextShort;
    else if (nextLong !== -1) nextStart = nextLong;

    if (nextStart === -1) {
      msgArray.push(Buffer.from(data.slice(pos)));
      break;
    }
    msgArray.push(Buffer.from(data.slice(pos, nextStart)));
    pos = nextStart;
  }

  return msgArray;
}

module.exports = Gt06;
