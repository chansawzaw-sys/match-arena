# Deploy on Railway — Match Arena (Parts 1–9)

Railway မှာ ရပါတယ်။ ဒီ project က Railway နဲ့ ကိုက်ပါတယ်၊ ဘာလို့လဲဆိုတော့:

- `package.json` မှာ `start: node src/server.js` ရှိပြီး
- `PORT` ကို environment ကနေ ယူပါတယ် — Railway က PORT ကို သူ့ဘာသာ ပေးပါတယ်၊
  ကိုယ်တိုင် PORT သတ်မှတ်စရာ မလိုပါဘူး
- `railway.json` မှာ Nixpacks build + `npm start` + `/health` healthcheck ပါပြီးသားပါ

## အရေးကြီးဆုံး အချက် — Database နဲ့ ဖိုင်တွေ မပျောက်အောင်

Railway ရဲ့ filesystem က redeploy လုပ်ရင် ပျောက်ပါတယ်။ ဒါကြောင့် Volume
တစ်ခု မဖြစ်မနေ ထည့်ရပါမယ်။

- Railway project → service → **Volumes** → Add Volume
- Mount path: `/app/data`
- ပြီးရင် Variables မှာ `DB_PATH=/app/data/app.sqlite` လို့ ထားပါ

အဲဒီလိုလုပ်ရင် database ရော၊ screenshot evidence / avatar / banner ဖိုင်တွေပါ
(`/app/data/` အောက်မှာပဲ ရှိလို့) redeploy ပြီးလည်း မပျောက်ပါဘူး။
Volume မထည့်ရင် ပထမဆုံး deploy မှာ အလုပ်လုပ်သလို ထင်ရပေမယ့်၊ နောက်
redeploy မှာ user / coin / match အားလုံး ပျောက်သွားပါမယ်။

## Variables (Railway → service → Variables)

မဖြစ်မနေ:

- `NODE_ENV=production`
- `JWT_SECRET=` — အရှည်၊ ကျပန်း စာလုံး (ဘယ်သူနဲ့မှ မမျှပါနဲ့)
- `APP_ENCRYPTION_KEY=` — အရှည်၊ ကျပန်း စာလုံး
- `DB_PATH=/app/data/app.sqlite`
- `CORS_ORIGIN=https://<ကိုယ့် Railway domain>`
- `PUBLIC_BASE_URL=https://<ကိုယ့် Railway domain>`

Google login သုံးချင်ရင် (production မှာ login လုပ်ဖို့ မဖြစ်မနေ):

- `GOOGLE_CLIENT_ID=`
- `GOOGLE_CLIENT_SECRET=`
- `GOOGLE_CALLBACK_URL=https://<ကိုယ့် Railway domain>/auth/google/callback`

Google Cloud Console မှာ callback URL က အတိအကျ တူရပါမယ်။

**သတိ:** production မှာ demo login အလိုအလျောက် ပိတ်ထားပါတယ်။ Google keys
မရှိရင် ဘယ်သူမှ login လုပ်လို့ မရပါဘူး။ ဒါကြောင့် Google keys က
Railway deploy ရဲ့ မဖြစ်မနေ အစိတ်အပိုင်းပါ။

မထည့်လဲ ရတာများ:

- Telegram bot token — admin dashboard ထဲက Telegram config မှာ နောက်မှ ထည့်လို့ရပါတယ်။
  မထည့်ရင် Telegram test က 503 ပြန်ပါမယ်၊ အဲဒါ ပုံမှန်ပါ။

မထည့်ရမယ့်ဟာ:

- `PORT` ကို ကိုယ်တိုင် မသတ်မှတ်ပါနဲ့ — Railway က ပေးတဲ့ PORT ကို သုံးရပါမယ်။

## Deploy အဆင့်များ

1. Railway မှာ account ဖွင့်ပါ (Hobby plan က လစဉ် $5 လောက် usage credit
   ဖြစ်ပါတယ်၊ သုံးတာနဲ့ တွက်ပါတယ် — $20/vCPU/month၊ $10/GB RAM/month၊
   Volume $0.15/GB/month လောက်၊ အတိအကျက Railway pricing စာမျက်နှာမှာ
   စစ်ပါ)။
2. GitHub repo တစ်ခုမှာ ဒီ code ကို တင်ပါ၊ Railway project → New →
   Deploy from GitHub repo ကနေ အဲဒီ repo ကို ရွေးပါ။
   (သို့မဟုတ် Railway CLI နဲ့ `railway link` → `railway up` လုပ်ပါ။)
3. အပေါ်က Variables တွေ ထည့်ပါ။
4. Volume ကို `/app/data` မှာ ထည့်ပါ။
5. Railway က ပေးတဲ့ domain ကို Settings → Networking → Generate Domain မှာ
   ယူပါ။ Custom domain ရှိရင် အဲဒါကို ချိတ်ပါ။
6. Domain ရပြီးရင် `CORS_ORIGIN` / `PUBLIC_BASE_URL` / Google callback URL
   တို့ကို domain အသစ်နဲ့ ပြန်ပြင်ပြီး redeploy လုပ်ပါ။

## Deploy ပြီးရင် စစ်ရမယ့်အချက်များ

- `https://<domain>/health` က `{"ok":true,"part":9,"moneyMovementEnabled":false}` ပြန်ရမယ်
- Google နဲ့ login ဝင်လို့ရမယ်
- Admin account နဲ့ ဝင်ပြီး 2FA ဖွင့်ပါ

## သတိထားရမယ့်အချက်များ

- Money guard များ (`money_movement_enabled`, `paid_entry_enabled`,
  `withdrawals_enabled`) က `false` ပါ။ ငွေအစစ် ထုတ်တဲ့ လမ်းကြောင်း၊ payment
  gateway မပါပါဘူး။ Coin က platform အတွင်း ledger သက်သက်ပါ။
- Server log မှာ error တွေ့ရင် အဲဒီ log + ဘာလုပ်နေတုန်း ဖြစ်တယ်ဆိုတာကို
  ပို့ပေးပါ — လိုက်ပြင်ပေးပါမယ်။
