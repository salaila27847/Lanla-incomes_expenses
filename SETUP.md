# Setup: Google Sheets database

The `/controller` service needs a real Google Sheet and a service account to talk to it. Neither exists yet — these are manual, one-time steps only you can do (they need your own Google account). Everything works locally without this via `SHEETS_MOCK_MODE=true` (the default), so you can develop and test first and do this whenever you're ready to go live.

## 1. Create the Google Sheet

Create a new Google Sheet with two tabs, each with an exact header row in row 1:

**Tab `MasterItems`**
| Name | Category | CreatedAt |
|------|----------|-----------|

**Tab `PriceHistory`**
| Date | Store | MasterItemName | Category | Price |
|------|-------|-----------------|----------|-------|

Leave both tabs otherwise empty — rows get appended by the app.

Copy the spreadsheet ID out of its URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.

## 2. Create a GCP service account

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project (or reuse one).
2. Enable the **Google Sheets API** for that project.
3. Go to **IAM & Admin → Service Accounts → Create Service Account**. Any name is fine.
4. Open the new service account → **Keys → Add Key → Create new key → JSON**. This downloads a `.json` key file — keep it out of git (it's covered by `.gitignore`'s `*-service-account.json` pattern; name the file accordingly, or add its exact name to `.gitignore` yourself).

## 3. Share the Sheet with the service account

Open the Google Sheet, click **Share**, and add the service account's email (looks like `something@your-project.iam.gserviceaccount.com`, visible on its details page) with **Editor** access.

## 4. Configure the controller

In `controller/.env` (copy from `controller/.env.example`):

```
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./path/to/the-downloaded-key.json
SHEETS_SPREADSHEET_ID=<the ID from step 1>
SHEETS_MOCK_MODE=false
```

Restart the controller. `readMasterItems`/`appendMasterItem`/`appendPriceHistoryRow` (`controller/src/sheets/client.ts`) now hit the real Sheet instead of the in-memory mock.
