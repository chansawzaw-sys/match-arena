# Deploy — Match Arena (Parts 1–9)

ဒီ guide က local မှာ စမ်းတာရော၊ VPS မှာ အပြင်မှာ ဖွင့်တာရော နှစ်မျိုးလုံး ပါပါတယ်။
Code က Node.js 20+ / Express / SQLite ပါ။ Database ကို နောက်မှ PostgreSQL နဲ့ လဲလို့ရအောင်
ဒီဇိုင်းလုပ်ထားပေမယ့်၊ အခု deploy မှာ SQLite နဲ့ပဲ စလို့ရပါတယ်။

## 1. လိုအပ်တာများ (မဖြစ်မနေ)

- Node.js 20 သို့မဟုတ် အထက်
- npm
- Port 3000 (သို့မဟုတ် ကိုယ်သတ်မှတ်တဲ့ PORT) ဖွင့်ထားခြင်း

## 2. Local မှာ စမ်းခြင်း (Windows / ကွန်ပျူတာ)

```powershell
cd mlbb-new-platform
npm install
npm test
npm start
```

Browser မှာ `http://localhost:3000` ကို ဖွင့်ပါ။
Local demo login က development မှာပဲ ရပါတယ်။ `NODE_ENV=production` ဖြစ်ရင်
demo login အလိုအလျောက် ပိတ်သွားပါတယ်။

## 3. VPS မှာ ဖွင့်ခြင်း (Ubuntu ဥပမာ)

```bash
# Node.js 20 သွင်းပါ (NodeSource သို့မဟုတ် apt ဖြင့်)
node --version   # v20+ ဖြစ်ရမယ်

cd mlbb-new-platform
npm install --omit=dev
npm test
```

### .env ဖိုင် ပြင်ခြင်း

`.env.example` ကို ကူးပြီး `.env` လုပ်ပါ။ ဘာမှ အလွတ်မထားဘဲ အောက်ပါတို့ကို ဖြည့်ပါ။

- `NODE_ENV=production`
- `PORT=3000`
- `JWT_SECRET=` — အရှည်၊ ကျပန်း စာလုံး (အနည်းဆုံး ၃၂ လုံး)၊ ဘယ်သူနဲ့မှ မမျှပါနဲ့
- `APP_ENCRYPTION_KEY=` — အရှည်၊ ကျပန်း စာလုံး
- `DB_PATH=./data/app.sqlite`
- `CORS_ORIGIN=` — ကိုယ့် domain အပြည့် (ဥပမာ https://example.com)
- Google login သုံးချင်ရင်: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_CALLBACK_URL=https://<ကိုယ့် domain>/auth/google/callback`
  (Google Cloud Console မှာ callback URL က အတိအကျ တူရမယ်)
- Telegram သုံးချင်ရင်: admin dashboard ထဲက Telegram config မှာ bot token နဲ့
  admin chat id ထည့်ပါ။ Token မရှိရင် Telegram test က 503 ပြန်မယ် — အဲဒါက ပုံမှန်ပါ၊
  အတုအောင်တယ်လို့ မပြပါဘူး။

`.env` ဖိုင်ကို Git / zip ထဲမှာ ဘယ်တော့မှ မထည့်ပါနဲ့။

### Server ကို ဆက်တိုက်လည်အောင် လုပ်ခြင်း

PM2 ဥပမာ:

```bash
npm install -g pm2
pm2 start src/server.js --name match-arena
pm2 save
pm2 startup
```

သို့မဟုတ် systemd service တစ်ခု ဖန်တီးပြီး `npm start` ကို run ပါ။

### HTTPS (domain ရှိမှ)

Caddy က အလွယ်ဆုံးပါ — domain ကို Caddy မှာ reverse proxy လုပ်ရင်
HTTPS certificate အလိုအလျောက် ရပါတယ်:

```
example.com {
    reverse_proxy localhost:3000
}
```

Nginx + certbot နဲ့လည်း ရပါတယ်။ HTTPS မရှိရင် PWA install လုပ်လို့မရပါဘူး
(localhost မှာတော့ စမ်းလို့ရပါတယ်)။

## 4. Deploy ပြီးရင် စစ်ရမယ့် အချက်များ

- `GET /health` က `{"ok":true,"part":9,"moneyMovementEnabled":false}` ပြန်ရမယ်
- Browser မှာ homepage၊ login၊ challenge board ဖွင့်လို့ရမယ်
- Admin account နဲ့ ဝင်ပြီး 2FA ဖွင့်ပါ
- Site config (logo၊ banner၊ announcement) စစ်ပါ

## 5. သတိထားရမယ့် အချက်များ

- Money guard များ (`money_movement_enabled`, `paid_entry_enabled`,
  `withdrawals_enabled`) က `false` ပါ။ ငွေအစစ် ထုတ်တဲ့ လမ်းကြောင်း၊ payment
  gateway မပါပါဘူး။ ဒါကို ဖွင့်ချင်ရင် စာချုပ်အပြီးသတ်ပြီးမှ၊ owner setting နဲ့
  သီးခြား ဆုံးဖြတ်ပါ။
- Database backup: admin dashboard က backup endpoint နဲ့ SQLite ဖိုင်ကို
  backup လုပ်ပါ။ Evidence / avatar / banner ဖိုင်တွေက `data/` အောက်မှာ ရှိပြီး
  DB backup ထဲမှာ မပါဘူး — အဲဒီဖိုင်တွေကိုလည်း သီးခြား backup လုပ်ပါ။
- Server log မှာ error တွေ့ရင် အဲဒီ log + ဘာလုပ်နေတုန်း ဖြစ်တယ်ဆိုတာကို
  screenshot / စာနဲ့ ပို့ပေးပါ — လိုက်ပြင်ပေးပါမယ်။

## 6. အဖြစ်များတဲ့ ပြဿနာများ

- `EADDRINUSE` — Port 3000 ကို တခြား process သုံးနေလို့၊ PORT ပြောင်းပါ
  သို့မဟုတ် အဲဒီ process ကို ရပ်ပါ။
- Google login 400 / redirect mismatch — callback URL က Google Console နဲ့
  အတိအကျ မတူလို့ပါ၊ domain + path အကုန် စစ်ပါ။
- Demo login မရဘူး — production မှာ demo login ပိတ်ထားလို့ ပုံမှန်ပါ၊
  Google login (သို့မဟုတ်) admin က ဖန်တီးပေးတဲ့ account နဲ့ ဝင်ပါ။
- Telegram test 503 — bot token မထည့်ရသေးလို့ ပုံမှန်ပါ။
