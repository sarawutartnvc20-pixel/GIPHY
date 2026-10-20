# KlipFox GIF proxy

เซิร์ฟเวอร์ตัวกลางสำหรับหน้า "GIF มีมฟรี" เก็บ GIPHY API key ไว้ฝั่งเซิร์ฟเวอร์ ผู้ใช้แอปไม่ต้องกรอก key และไม่เห็น key
ใช้ Node.js 20 ขึ้นไป ไม่ต้องลงแพ็กเกจเพิ่ม (ไม่ต้อง `npm install`)

## รันในเครื่อง

```bash
cp .env.example .env        # แล้วแก้ GIPHY_API_KEY=... ใน .env
node server.js              # หรือ npm start
```

เปิด http://localhost:8000/health ต้องได้ `{"ok":true,...}`

## Endpoint

| เส้นทาง | ใช้ทำอะไร |
|---|---|
| `GET /api/stickers?q=&offset=&limit=` | สติ๊กเกอร์โปร่งใส (ไม่ใส่ `q` = ยอดฮิต / trending) |
| `GET /api/gifs?q=&offset=&limit=` | GIF (ไม่ใส่ `q` = ยอดฮิต) |
| `GET /api/media?url=...` | ส่งต่อไฟล์ GIF/MP4 จาก media.giphy.com พร้อม CORS ให้แอปวาดลงวิดีโอและส่งออกได้ (รับเฉพาะลิงก์ของ GIPHY) |
| `GET /health` | ตรวจว่าเซิร์ฟเวอร์ทำงาน |

- **Cache**: ผลค้นหาเก็บไว้ 5 นาที (`CACHE_SECONDS`) คำขอซ้ำในช่วงนี้ไม่เรียก GIPHY ซ้ำ ดูได้จาก header `X-Cache: HIT/MISS`
- คำขอเดียวกันที่เข้ามาพร้อมกันจะเรียก GIPHY ครั้งเดียว
- จำกัด 120 ครั้ง/นาที ต่อ IP (`RATE_LIMIT_PER_MIN`)
- key ไม่ถูกส่งกลับไปที่แอปและไม่ถูกพิมพ์ลง log

## ใช้กับ iPhone (ต้องเป็น https)

แอปบน Netlify เป็น https เลยเรียก `http://localhost:8000` จากมือถือไม่ได้ ต้องเอาเซิร์ฟเวอร์นี้ขึ้นโฮสต์ที่มี https เช่น Render, Railway หรือ Fly.io

ตัวอย่าง Render (มีแบบฟรี):
1. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub (ห้ามใส่ไฟล์ `.env`)
2. Render → New → Web Service → เลือก repo
3. Build command: เว้นว่าง · Start command: `node server.js`
4. Environment: ใส่ `GIPHY_API_KEY` และ `ALLOWED_ORIGINS=https://ชื่อเว็บของคุณ.netlify.app`
5. ได้ที่อยู่ เช่น `https://klipfox-gif.onrender.com` แล้วเอาไปใส่ใน `index.html` บรรทัด `window.KF_API = "..."`

หมายเหตุ: Render แบบฟรีจะหลับเมื่อไม่มีคนใช้ ครั้งแรกที่เปิดหลังหลับอาจช้า 30–60 วินาที
