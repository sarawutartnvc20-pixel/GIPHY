# KlipFox server: GIF + กรีนสกรีน + โหลดจากลิงก์

เซิร์ฟเวอร์ตัวกลางสำหรับหน้า "GIF มีมฟรี" (GIPHY) และหน้า "กรีนสกรีน" (Pixabay) เก็บ API key ไว้ฝั่งเซิร์ฟเวอร์ ผู้ใช้แอปไม่ต้องกรอก key และไม่เห็น key
ใช้ Node.js 20 ขึ้นไป ไม่ต้องลงแพ็กเกจเพิ่ม (ไม่ต้อง `npm install`)

## รันในเครื่อง

```bash
cp .env.example .env        # แล้วแก้ GIPHY_API_KEY=... และ PIXABAY_API_KEY=... ใน .env (ใส่แค่ตัวที่ใช้ก็ได้)
node server.js              # หรือ npm start
```

เปิด http://localhost:8000/health ต้องได้ `{"ok":true,...}`

## Endpoint

| เส้นทาง | ใช้ทำอะไร |
|---|---|
| `GET /api/stickers?q=&offset=&limit=` | สติ๊กเกอร์โปร่งใส (ไม่ใส่ `q` = ยอดฮิต / trending) |
| `GET /api/gifs?q=&offset=&limit=` | GIF (ไม่ใส่ `q` = ยอดฮิต) |
| `GET /api/pixabay?q=&page=&per_page=` | ค้นหาคลิปกรีนสกรีนจาก Pixabay (ไม่ใส่ `q` = "green screen") |
| `GET /api/media?url=...` | ส่งต่อไฟล์ GIF/MP4 จาก media.giphy.com หรือ cdn.pixabay.com พร้อม CORS ให้แอปวาดลงวิดีโอและส่งออกได้ (รับเฉพาะลิงก์ของสองเว็บนี้) |
| `GET /api/dl/info?url=` | ชื่อ / ความยาว / รูปตัวอย่างของคลิปจากลิงก์ YouTube · TikTok · Facebook · Instagram |
| `GET /api/dl/start?url=&fmt=mp4\|mp3&h=1080` | เริ่มโหลดคลิปบนเซิร์ฟเวอร์ ได้ `{ id }` |
| `GET /api/dl/status?id=` | ความคืบหน้า `{ state, pct, size, error }` |
| `GET /api/dl/file?id=` | ไฟล์ที่โหลดเสร็จ (ลบออกจากเซิร์ฟเวอร์เองหลัง 10 นาที) |
| `GET /health` | ตรวจว่าเซิร์ฟเวอร์ทำงาน (บอกด้วยว่ามีตัวโหลดคลิปไหม) |

- **Cache**: ผลค้นหา GIPHY เก็บไว้ 5 นาที (`CACHE_SECONDS`) ส่วน Pixabay เก็บ 24 ชั่วโมง (`PIXABAY_CACHE_SECONDS`) ตามที่ Pixabay ขอให้ทำ คำขอซ้ำในช่วงนี้ไม่เรียก GIPHY ซ้ำ ดูได้จาก header `X-Cache: HIT/MISS`
- คำขอเดียวกันที่เข้ามาพร้อมกันจะเรียก GIPHY ครั้งเดียว
- จำกัด 120 ครั้ง/นาที ต่อ IP (`RATE_LIMIT_PER_MIN`)
- key ไม่ถูกส่งกลับไปที่แอปและไม่ถูกพิมพ์ลง log

## ใช้กับ iPhone (ต้องเป็น https)

แอปบน Netlify เป็น https เลยเรียก `http://localhost:8000` จากมือถือไม่ได้ ต้องเอาเซิร์ฟเวอร์นี้ขึ้นโฮสต์ที่มี https เช่น Render, Railway หรือ Fly.io

ตัวอย่าง Render (มีแบบฟรี):
1. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub (ห้ามใส่ไฟล์ `.env`)
2. Render → New → Web Service → เลือก repo
3. Build command: เว้นว่าง · Start command: `node server.js`
4. Environment: ใส่ `GIPHY_API_KEY`, `PIXABAY_API_KEY` และ `ALLOWED_ORIGINS=https://ชื่อเว็บของคุณ.netlify.app`
5. ได้ที่อยู่ เช่น `https://klipfox-gif.onrender.com` แล้วเอาไปใส่ใน `index.html` บรรทัด `window.KF_API = "..."`

หมายเหตุ: Render แบบฟรีจะหลับเมื่อไม่มีคนใช้ ครั้งแรกที่เปิดหลังหลับอาจช้า 30–60 วินาที


## โหลดจากลิงก์ในแอป (ไม่ต้องผ่าน SaveFrom)

ต้องมี `yt-dlp` และ `ffmpeg` บนเซิร์ฟเวอร์ วิธีง่ายสุดคือใช้ `Dockerfile` ที่ให้มา

Render: New → Web Service → เลือก repo → Language / Runtime เลือก **Docker** แล้วใส่ Environment เหมือนเดิม
(ถ้าไม่มี yt-dlp เซิร์ฟเวอร์ยังทำงานส่วน GIF / กรีนสกรีนได้ปกติ แอปจะกลับไปใช้ SaveFrom ให้เอง)

ข้อควรรู้
- ใช้กับคลิปที่คุณมีสิทธิ์นำมาใช้เท่านั้น บางเว็บ (โดยเฉพาะ YouTube) ห้ามดาวน์โหลดในข้อตกลงการใช้งาน
- YouTube มักบล็อกเซิร์ฟเวอร์ในคลาวด์ ("Sign in to confirm you're not a bot") ถ้าเจอบ่อย แอปจะบอกว่าเว็บบล็อก ส่วน TikTok / Facebook / Instagram ขึ้นกับคลิป (คลิปส่วนตัวโหลดไม่ได้)
- จำกัดความยาว 15 นาที (`DL_MAX_SECONDS`) ขนาด 400 MB (`DL_MAX_MB`) และโหลดพร้อมกัน 2 คลิป (`DL_PARALLEL`)
- คอนเทนเนอร์อัปเดต yt-dlp ทุกครั้งที่เริ่ม เพราะเว็บเปลี่ยนวิธีบ่อย
