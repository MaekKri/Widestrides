# Widestrides Web — คู่มือติดตั้ง (ฟรี)

เว็บนี้เป็นไฟล์ static ล้วนๆ (HTML/CSS/JS) ยกเครื่องคำนวณ Pöhlitz/Riegel มาจากแอป iOS
ค่า pace ตรงกับแอปทุกวินาที มีระบบล็อกอิน + invite code + หน้าแอดมินให้คุณ

**ไฟล์ในโฟลเดอร์นี้**
- `index.html`, `styles.css`, `app.js`, `engine.js` — ตัวเว็บ
- `config.js` — ที่ใส่คีย์ Supabase (ต้องแก้)
- `supabase-schema.sql` — โครงฐานข้อมูล (ก็อปไปวางใน Supabase)

---

## ลองก่อนได้เลย (โหมด local ไม่ต้องตั้งอะไร)
เปิด `index.html` ในเบราว์เซอร์ หรือ deploy ขึ้น Vercel เลยก็ได้ — ถ้ายังไม่ใส่คีย์ Supabase
เว็บจะรันแบบ **local mode**: ไม่มีล็อกอิน เก็บแผนไว้ในเครื่องเบราว์เซอร์ ใช้ดูหน้าตา/ทดลองได้
พอใส่คีย์แล้วถึงจะเปิดระบบสมาชิก + invite code

---

## ทำให้ใช้จริง (มีล็อกอิน + invite code) — ทำครั้งเดียว

### ขั้น 1 — สร้างโปรเจกต์ Supabase (ฟรี)
1. ไปที่ https://supabase.com → Sign in ด้วย GitHub หรืออีเมล
2. New project → ตั้งชื่อ เช่น `widestrides` → ตั้งรหัส database → เลือก region ใกล้ไทย (Singapore) → Create
3. รอ ~2 นาทีให้โปรเจกต์พร้อม

### ขั้น 2 — สร้างตาราง
1. เมนูซ้าย → **SQL Editor** → New query
2. เปิดไฟล์ `supabase-schema.sql` ก็อปทั้งไฟล์ไปวาง → กด **Run**
3. ควรขึ้น "Success" (รันซ้ำได้ ไม่พัง)

### ขั้น 3 — เอาคีย์มาใส่ config.js
1. เมนูซ้าย → **Project Settings** → **API**
2. ก็อป **Project URL** และ **anon public key**
3. เปิดไฟล์ `config.js` แล้วแก้เป็น:
```js
window.WIDESTRIDES_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ....(anon key ยาวๆ)",
};
```
> anon key เปิดเผยได้ปลอดภัย — มันเป็นคีย์ public ที่ออกแบบมาให้ใส่ในเว็บ ข้อมูลถูกป้องกันด้วย RLS (Row Level Security) ที่ SQL ตั้งไว้แล้ว

### ขั้น 4 — (แนะนำ) ปิดการยืนยันอีเมล เพื่อสมัครแล้วเข้าได้เลย
Supabase → **Authentication** → **Providers** → **Email** → ปิด "Confirm email" → Save
(ถ้าไม่ปิด ผู้สมัครต้องกดลิงก์ยืนยันในอีเมลก่อน)

### ขั้น 5 — ตั้งตัวเองเป็นแอดมิน
1. เปิดเว็บ → **สมัครสมาชิก** ด้วยอีเมลคุณเอง (`maek@basebangkok.com`) 1 ครั้ง
   - ตอนนี้มันจะขอ invite code แต่คุณยังไม่มี — ไม่เป็นไร ข้ามไปทำข้อ 2
2. กลับไป Supabase → SQL Editor → รันคำสั่งนี้ (แก้อีเมลถ้าจำเป็น):
```sql
insert into public.members (user_id, email, is_admin)
select id, email, true from auth.users where email = 'maek@basebangkok.com'
on conflict (user_id) do update set is_admin = true;
```
3. รีเฟรชเว็บ → ตอนนี้คุณเข้าได้แล้วและเห็นแท็บ **Admin**
4. ไปแท็บ Admin → กด **Generate code** → เอาโค้ดไปให้ลูกค้าสมัคร

---

## เอาขึ้นเว็บให้คนอื่นเข้าได้ (ฟรี) — Vercel + GitHub

**วิธีที่ 1 — GitHub + Vercel (แนะนำ, อัปเดตง่าย)**
1. สร้าง repo ใหม่บน https://github.com แล้วอัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้ขึ้นไป
2. ไป https://vercel.com → Sign in ด้วย GitHub → **Add New → Project** → เลือก repo → **Deploy**
   - ไม่ต้องตั้ง build อะไร มันเป็น static เว็บ Vercel เสิร์ฟให้เลย
3. ได้ลิงก์ `https://widestrides.vercel.app` (ตั้งชื่อเองได้) แชร์ได้ทันที
4. เวลาแก้โค้ด → push ขึ้น GitHub → Vercel deploy ใหม่ให้อัตโนมัติ

**วิธีที่ 2 — เร็วสุด ไม่ต้องใช้ GitHub**
- ไป https://app.netlify.com/drop → ลากทั้งโฟลเดอร์ไปวาง → ได้ลิงก์ทันที (อัปเดตทีหลังต้องลากใหม่)

> ⚠️ ผมสร้างบัญชี GitHub/Supabase/Vercel หรือกรอกรหัสให้ไม่ได้ (กฎความปลอดภัย) — 3 ขั้นนี้คุณต้องกดสมัครเอง แต่ผมอยู่ช่วยไล่ทีละสเต็ปได้ตลอด

---

## ระบบ invite code ทำงานยังไง
- ใครก็สมัคร (อีเมล+รหัส) ได้ แต่ **เข้าใช้แอปไม่ได้** จนกว่าจะกรอก invite code ที่ถูกต้อง
- โค้ดแต่ละอันใช้ได้ **ครั้งเดียว** ใช้แล้วขึ้นสถานะ "used" คุณกด disable ได้
- มีแต่แอดมิน (คุณ) เท่านั้นที่สร้าง/เห็น/ปิดโค้ดได้ (บังคับด้วย RLS)
- ข้อมูลแผนของแต่ละคนแยกกัน เห็นได้เฉพาะเจ้าของ

## ค่าใช้จ่าย
ฟรีหมดในช่วงแรก (Supabase free: 50,000 users/เดือน, Vercel free hosting)
คนใช้เยอะจริงค่อยอัปเกรด Supabase ~$25/เดือน
