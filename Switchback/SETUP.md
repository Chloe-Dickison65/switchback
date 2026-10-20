# Getting Switchback onto your Pixel

About 20 minutes, one time. Do the steps in order: step 2 needs the web address from step 1.

## 1. Put the app online (GitHub Pages, free)

1. Go to **github.com** and sign up or sign in. Turn on **two-factor authentication** (profile picture → **Settings → Password and authentication**).
2. Click **+** (top right) → **New repository**.
   - Name: `switchback`. Visibility: **Public** (free Pages sites need this; the code holds no personal data or keys).
   - Click **Create repository**.
3. On the new page, click **uploading an existing file**.
4. In Finder, open **Documents → Switchback → switchback**. Select **everything inside** that folder (css, icons, js, index.html, manifest.webmanifest, sw.js) and drag it onto the GitHub page. Drag the contents, not the folder itself.
5. Click **Commit changes**.
6. Go to the repository's **Settings → Pages**. Under **Branch**, choose **main** and **/ (root)** → **Save**.
7. After a minute or two, the page shows your address: `https://YOUR-USERNAME.github.io/switchback/`. Open it to check that Switchback loads.

To ship an update later: in the repository, click **Add file → Upload files** and drag the contents of the `switchback` folder in again. Matching files are replaced.

## 2. Let it read your Google Calendar (Google Cloud, free)

1. Go to **console.cloud.google.com** and sign in with the Google account your calendar is on.
2. At the top, click the project picker → **New project**. Name it `Switchback` and select it.
3. Search for **"Google Calendar API"** → **Enable**.
4. Go to **APIs & Services → OAuth consent screen** (it may be called **Google Auth Platform**) → **Get started**:
   - App name: `Switchback`. Support email: yours.
   - Audience: **External**.
   - Contact email: yours → Create.
   - Under **Audience → Test users**, **add your own Gmail address**. This step is easy to miss.
5. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**):
   - Application type: **Web application**.
   - **Authorized JavaScript origins**: add `https://YOUR-USERNAME.github.io` (just that part: no `/switchback`, no slash at the end).
   - Create, then copy the **Client ID**. It ends in `.apps.googleusercontent.com`.

When you connect, Google will say **"Google hasn't verified this app."** That's expected for a personal app. Click **Continue**.

## 3. Turn on the AI coach (Anthropic, pay-as-you-go)

Do this step on your phone, so you can paste the key straight into the app.

1. Go to **console.anthropic.com** and sign in or sign up.
2. **Billing**: add the smallest amount of credit it allows. At about 0.1¢ per message, a few dollars lasts a very long time.
3. **Limits**: set a low **monthly spend limit** (e.g. $1). This is the backstop behind the app's own weekly cap.
4. **API keys → Create key**: name it `Switchback` and copy it. It starts with `sk-ant-`.

## 4. Install on your Pixel

1. Open `https://YOUR-USERNAME.github.io/switchback/` in **Chrome** on the phone.
2. Open the **⋮** menu → **Add to Home screen** (or **Install app**).
3. Open Switchback from your home screen → **Settings**:
   - Paste the **Anthropic API key**.
   - Paste the **Google client ID** → **Connect Google Calendar** → allow access.
   - Tap **Add Sunday reminder**.
   - Check your **office days** and the **About me** text.
4. Go to **Week** → **Plan this week**.

## Good to know

- Your data lives only on the phone. Use **Settings → Export backup** now and then.
- Workouts appear on a separate **Workouts** calendar in Google Calendar, which sends the reminders. Make sure notifications are on for the Google Calendar app.
- If the calendar chip at the top says **Connect**, tap it. Google sign-ins expire after about an hour, so you'll occasionally need to reconnect.
