# Membership Dashboard — Netlify Deployment Guide

## What this is
A password-protected dashboard that pulls live membership data from ServiceTitan and shows sold, cancelled, and net gain by person — with office vs. technician breakdowns.

---

## Prerequisites
- A [Netlify](https://netlify.com) account (free tier works)
- A [GitHub](https://github.com) account (easiest deploy path)
- Your ServiceTitan API credentials: App ID, App Key, Tenant ID

---

## Deploy in 5 steps

### 1. Push to GitHub
Upload this entire `st-dashboard` folder to a new GitHub repository.

### 2. Connect to Netlify
1. Log in to Netlify → **Add new site** → **Import an existing project**
2. Choose GitHub and select your repository
3. Build settings are auto-detected from `netlify.toml` — leave them as-is
4. Click **Deploy site**

### 3. Add environment variables
In Netlify: **Site Settings → Environment Variables → Add variable**

| Key | Value |
|-----|-------|
| `ST_APP_ID` | Your ServiceTitan App ID |
| `ST_APP_KEY` | Your ServiceTitan App Key |
| `ST_TENANT_ID` | Your ServiceTitan Tenant ID |

After adding variables, trigger a redeploy: **Deploys → Trigger deploy**.

### 4. Access your dashboard
Your site will be live at `https://your-site-name.netlify.app`.  
Password: **MVP**

---

## Updating office staff names
Open `public/index.html` and find this line near the top of the `<script>` section:

```js
const OFFICE_STAFF = ['Mikaela', 'Mariela', 'Amanda', 'Danielle', 'Taylor'];
```

Add or remove names as needed, commit, and Netlify will auto-redeploy.

---

## How data is pulled
The Netlify serverless function (`netlify/functions/servicetitan.js`) calls the ServiceTitan Memberships API v2:

- **Sold** = memberships created in the selected date range
- **Lost/Cancelled** = memberships with status `Cancelled`, modified in the selected date range
- Memberships containing **"Free"** in the type name are automatically excluded

---

## Troubleshooting

**"Error loading data" on the dashboard**
- Verify your three environment variables are set correctly in Netlify
- Check that your ServiceTitan App has access to the Memberships v2 API scope
- Open browser DevTools → Network tab → look at the failing request to `/.netlify/functions/servicetitan` for the specific error

**Data looks wrong / "Unknown" names**
- ServiceTitan's API field names can vary by account configuration. Open Netlify's Function logs (Functions → servicetitan → Logs) to inspect raw API responses and adjust field mappings in the function if needed.

**Want to change the password?**
Open `public/index.html`, find `const PASSWORD = 'MVP';` and change it.
