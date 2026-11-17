# Academy WhatsApp Bot

Attendance, test marks and fee automation for a coaching academy. Node.js + Baileys + Gemini 2.5 Flash + Google Sheets.

## 1. Test locally first (no WhatsApp / Google / Gemini needed)
```bash
npm install
npm test                          # 21 end-to-end tests with fakes
SHOW_TRANSCRIPT=1 npm test        # also prints every message the bot would send
```

## 2. Google Sheet
Create a spreadsheet, share it (Editor) with the service-account e-mail. Tabs/headers are created automatically.
Fill **Students** only:

| StudentID | Name | Class | ParentName | ParentPhone | MonthlyFee | RollNo | Active |
|---|---|---|---|---|---|---|---|
| S001 | Ayesha Khan | 10A | Mr Khan | 0300-1234567 | 5000 | 1 | yes |

Phones may be `0300…`, `+92 300…`, `300…` (Sheets drops the zero) – all normalised. `Active = no` hides a student. MonthlyFee 0 = no fee tracking.

Google Cloud (free): new project → enable *Google Sheets API* → Service Account → JSON key → `GOOGLE_SERVICE_ACCOUNT_FILE`.
Gemini key: aistudio.google.com → `GEMINI_API_KEY`.

## 3. Run
```bash
cp .env.example .env   # fill in
npm start
```
Open `http://localhost:3000/qr?token=<ADMIN_TOKEN>` → WhatsApp → Linked devices → scan.
Each group the bot sees is logged once as `group seen: 1203…@g.us` — copy those into `ALLOWED_GROUP_JIDS`, add teachers to `TEACHER_PHONES`.

## 4. Owner commands (private chat with the bot number)
Payment screenshot + caption (`Ayesha 10A`) · `report` · `remind` · `paid <name|id>` · `help`

## Notes
- Hosting: needs a **persistent disk** (`auth_info_baileys/`, `state/`). Use a home PC/Raspberry Pi or Oracle Cloud Always-Free VM; ephemeral free hosts lose the WhatsApp session on every deploy.
- Baileys is unofficial (violates WhatsApp ToS). Use a dedicated SIM, keep the 15–25 s delay, and expect occasional breakage. If pairing fails: `npm i @whiskeysockets/baileys@latest` (project is ESM so v6 and v7 both load).
- Gemini free tier is rate-limited and Google may use free-tier prompts for product improvement – you are sending student names. Check current limits/terms.
- `@google/generative-ai` is Google's legacy SDK (still works); migrate to `@google/genai` later if desired.
