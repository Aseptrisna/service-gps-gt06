# TrackPro GPS Worker

Standalone Node.js service yang menerima data TCP dari GPS Tracker GT06,
menyimpan ke MongoDB, dan broadcast real-time via WebSocket (Socket.IO).

## Arsitektur

```
┌──────────────┐     TCP :8090     ┌──────────────────┐
│  GPS GT06    ├──────────────────►│  GPS Worker      │
│  Tracker     │                   │                  ├──► MongoDB (gps_data, devices)
└──────────────┘                   │  - Parse GT06    │
                                   │  - Save to DB    ├──► WebSocket :8091/tracking
┌──────────────┐     WS :8091      │  - Broadcast WS  │
│  Frontend    ├◄──────────────────┤                  │
│  (React)     │                   └──────────────────┘
└──────────────┘
```

## Protocol Support

| Event    | Protocol | Deskripsi                          | Response |
| -------- | -------- | ---------------------------------- | -------- |
| Login    | `0x01`   | Device login, kirim IMEI           | ✅ Ya    |
| Location | `0x12`   | Data GPS (lat, lon, speed, course) | ❌ Tidak |
| Status   | `0x13`   | Battery, GSM signal, terminal info | ✅ Ya    |
| Alarm    | `0x16`   | SOS, shock, power cut, low battery | ❌ Tidak |

## Setup

### 1. Install dependencies

```bash
cd gps-worker
npm install
```

### 2. Konfigurasi environment

```bash
cp .env.example .env
nano .env
```

```env
MONGODB_URI=mongodb://localhost:27017/fleet_monitoring
TCP_HOST=0.0.0.0
TCP_PORT=8090
WS_PORT=8091
WS_CORS_ORIGIN=*
LOG_LEVEL=info
```

### 3. Jalankan

```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

## Deploy di Linux Server

### Option A: systemd (Recommended)

```bash
# Copy project ke server
scp -r gps-worker/ user@server:/opt/trackpro/gps-worker/

# Di server:
cd /opt/trackpro/gps-worker
npm install --production

# Buat user khusus
sudo useradd -r -s /bin/false trackpro

# Copy dan enable service
sudo cp trackpro-gps.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable trackpro-gps
sudo systemctl start trackpro-gps

# Cek status
sudo systemctl status trackpro-gps

# Lihat logs
sudo journalctl -u trackpro-gps -f
```

### Option B: PM2

```bash
# Install PM2 global
npm install -g pm2

# Start worker
cd /opt/trackpro/gps-worker
pm2 start ecosystem.config.js

# Auto-start on boot
pm2 startup
pm2 save

# Monitor
pm2 logs trackpro-gps-worker
pm2 monit
```

## Firewall

Pastikan port TCP terbuka untuk GPS tracker:

```bash
# UFW
sudo ufw allow 8090/tcp comment "GPS GT06 Tracker"
sudo ufw allow 8091/tcp comment "GPS Worker WebSocket"

# iptables
sudo iptables -A INPUT -p tcp --dport 8090 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8091 -j ACCEPT
```

## Konfigurasi GPS GT06

Set IP dan port server di GPS tracker:

1. Kirim SMS ke nomor SIM di GPS tracker:
   ```
   SERVER,1,<IP_SERVER>,8090,0#
   ```
   Contoh:
   ```
   SERVER,1,103.123.45.67,8090,0#
   ```

2. Atau gunakan aplikasi konfigurasi GPS tracker untuk set:
   - **Server IP**: IP publik server Linux
   - **Server Port**: 8090
   - **Protocol**: TCP

## WebSocket Events

Frontend bisa connect ke `ws://<server>:8091/tracking` untuk real-time updates.

### Subscribe

```javascript
import { io } from 'socket.io-client';

const socket = io('ws://server-ip:8091/tracking');

// Subscribe semua kendaraan
socket.emit('subscribe_all');

// Subscribe kendaraan tertentu
socket.emit('subscribe_vehicle', vehicleId);
```

### Events yang diterima

| Event             | Payload                                       | Deskripsi              |
| ----------------- | --------------------------------------------- | ---------------------- |
| `location_update` | `{ imei, vehicle_id, lat, lon, speed, ... }`  | Update lokasi terbaru  |
| `vehicle_location`| `{ imei, vehicle_id, lat, lon, speed, ... }`  | Update per-kendaraan   |
| `device_status`   | `{ imei, terminalInfo, voltageLevel, ... }`   | Status device          |
| `alert`           | `{ imei, vehicle_id, alarmType, lat, lon }`   | Alarm dari device      |

## Database

Worker menulis ke database & collection yang sama dengan backend NestJS:

- **Database**: `fleet_monitoring`
- **Collection `gps_data`**: Menyimpan semua data GPS (lat, lon, speed, course, timestamp, raw_data)
- **Collection `devices`**: Update `status` → `online`/`offline` dan `last_seen`

⚠️ **Penting**: Device harus sudah terdaftar di database (melalui UI TrackPro atau API)
sebelum GPS tracker mengirim data. IMEI di database harus cocok dengan IMEI di tracker.

## Troubleshooting

### Device connect tapi tidak ada data

1. Cek IMEI sudah terdaftar: `db.devices.findOne({ imei: "123456789012345" })`
2. Cek log: `journalctl -u trackpro-gps -f` atau `pm2 logs`
3. Set `LOG_LEVEL=debug` di `.env` untuk detail parsing

### Port sudah dipakai

```bash
# Cek proses yang pakai port
sudo lsof -i :8090
sudo netstat -tlnp | grep 8090
```

### Test koneksi manual

```bash
# Kirim raw GT06 login packet (test)
echo -ne '\x78\x78\x0d\x01\x01\x23\x45\x67\x89\x01\x23\x45\x00\x01\x8c\xdd\x0d\x0a' | nc server-ip 8090
```
