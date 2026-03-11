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

  if (!checkHeader(data)) {
    throw { error: 'unknown message header', msg: data };
  }

  this.msgBufferRaw = sliceMsgsInBuff(data).slice();

  this.msgBufferRaw.forEach((msg, idx) => {
    const event = selectEvent(msg);

    switch (event.number) {
      case 0x01: // login
        Object.assign(parsed, parseLogin(msg));
        parsed.expectsResponse = true;
        parsed.responseMsg = createResponse(msg);
        break;
      case 0x12: // location
        Object.assign(parsed, parseLocation(msg), { imei: this.imei });
        break;
      case 0x13: // status / heartbeat
        Object.assign(parsed, parseStatus(msg), { imei: this.imei });
        parsed.expectsResponse = true;
        parsed.responseMsg = createResponse(msg);
        break;
      case 0x16: // alarm
        Object.assign(parsed, parseAlarm(msg), { imei: this.imei });
        break;
      default:
        throw { error: 'unknown message type', event };
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

// ─── Header check ───────────────────────────────────────────────────────────
function checkHeader(data) {
  return data.length >= 2 && data[0] === 0x78 && data[1] === 0x78;
}

// ─── Event selector ─────────────────────────────────────────────────────────
function selectEvent(data) {
  const EVENTS = {
    0x01: 'login',
    0x12: 'location',
    0x13: 'status',
    0x16: 'alarm',
  };
  return { number: data[3], string: EVENTS[data[3]] || 'unknown' };
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
function createResponse(data) {
  const resp = Buffer.from('787805FF0001d9dc0d0a', 'hex');
  resp[3] = data[3]; // protocol number from request
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
  const startPattern = Buffer.from('7878', 'hex');
  let nextStart = data.indexOf(startPattern, 2);
  const msgArray = [];

  if (nextStart === -1) {
    msgArray.push(Buffer.from(data));
    return msgArray;
  }

  msgArray.push(Buffer.from(data.slice(0, nextStart)));
  let remaining = Buffer.from(data.slice(nextStart));

  while (true) {
    nextStart = remaining.indexOf(startPattern, 2);
    if (nextStart === -1) {
      msgArray.push(Buffer.from(remaining));
      return msgArray;
    }
    msgArray.push(Buffer.from(remaining.slice(0, nextStart)));
    remaining = Buffer.from(remaining.slice(nextStart));
  }
}

module.exports = Gt06;
