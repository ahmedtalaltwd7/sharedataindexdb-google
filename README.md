# Fieldnotes

A local-first SvelteKit address book. Contacts and optional photos (up to 5 MB each) are stored in the browser's IndexedDB database (`local-first-records`, object store `savedData`) and remain available offline. Downloaded and Google Drive backups are ZIP files containing a JSON manifest and separate image files. Google Drive is optional and no application backend is involved.

## Run locally

```sh
npm install
npm run dev
```

## Enable Google Drive sync

1. In Google Cloud Console, create or select a project, enable the Google Drive API, and configure the OAuth consent screen.
2. Create an OAuth client ID with application type **Web application**. Add the app's origin (for local development, `http://localhost:5173`) to **Authorized JavaScript origins**.
3. Create a `.env` file in the project root and add:

   ```env
   VITE_GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
   ```

4. Restart the dev server. On a deployed app, configure the same variable in the hosting provider and add its origin to the OAuth client.

After setup, choose **Enable Drive sync** once and authorize Google Drive. The app creates or updates `saved-data-backup.zip` using Google's browser-based OAuth flow and the `drive.file` scope, which limits access to files created or opened by this app. The ZIP contains the JSON manifest and separate image files. Contacts and deletions are saved locally first; pending changes sync when the app is online and the current Google access token is valid. Keep the app open for sync to run when connectivity returns. If Google requires sign-in again or the token expires, choose **Sync now**; pending local changes are kept until sync succeeds. A ZIP download is also available without Google sign-in. Existing JSON backups in Google Drive remain available to restore.

The app shell is cached after the first successful visit, and contacts remain available from IndexedDB even without a network connection. Reconnect the browser and the app will request authorization as needed and upload pending local changes to Google Drive.

**Restore replaces all records in this browser.** The app asks for confirmation before replacing local data. Keep another backup before restoring if you need to preserve the current records.
