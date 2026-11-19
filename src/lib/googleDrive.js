const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const BACKUP_FILE_NAME = 'saved-data-backup.json';

let identityScriptPromise;
let cachedAccessToken;
let cachedAccessTokenExpiresAt = 0;

export function getCachedDriveAccessToken() {
	if (!cachedAccessToken || Date.now() >= cachedAccessTokenExpiresAt - 30_000) {
		cachedAccessToken = undefined;
		cachedAccessTokenExpiresAt = 0;
		return null;
	}

	return cachedAccessToken;
}

function getIdentityApi() {
	if (typeof window === 'undefined') throw new Error('Google Drive is only available in a browser.');
	if (window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts.oauth2);

	if (!identityScriptPromise) {
		identityScriptPromise = new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = GOOGLE_IDENTITY_SCRIPT;
			script.async = true;
			script.defer = true;
			script.onload = () => {
				if (window.google?.accounts?.oauth2) resolve(window.google.accounts.oauth2);
				else reject(new Error('Google Identity Services loaded without its OAuth API.'));
			};
			script.onerror = () => reject(new Error('Could not load Google Identity Services.'));
			document.head.appendChild(script);
		}).catch((error) => {
			identityScriptPromise = undefined;
			throw error;
		});
	}

	return identityScriptPromise;
}

export function prepareGoogleDrive() {
	return getIdentityApi();
}

export async function getDriveAccessToken(clientId) {
	if (!clientId) throw new Error('Set VITE_GOOGLE_CLIENT_ID before connecting Google Drive.');
	const cachedToken = getCachedDriveAccessToken();
	if (cachedToken) return cachedToken;
	const oauth2 = await getIdentityApi();

	return new Promise((resolve, reject) => {
		const tokenClient = oauth2.initTokenClient({
			client_id: clientId,
			scope: 'https://www.googleapis.com/auth/drive.file',
			callback: (response) => {
				if (response.error) {
					reject(new Error(response.error_description || response.error));
				} else if (response.access_token) {
					const expiresIn = Number(response.expires_in);
					cachedAccessToken = response.access_token;
					cachedAccessTokenExpiresAt =
						Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
					resolve(response.access_token);
				} else {
					reject(new Error('Google did not return an access token.'));
				}
			},
			error_callback: (error) => reject(new Error(error.message || 'Google sign-in was closed or failed.'))
		});

		tokenClient.requestAccessToken({ prompt: '' });
	});
}

async function driveRequest(url, token, options = {}) {
	const response = await fetch(url, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			...options.headers
		}
	});

	if (!response.ok) {
		if (response.status === 401) {
			cachedAccessToken = undefined;
			cachedAccessTokenExpiresAt = 0;
		}
		let message = `Google Drive request failed (${response.status}).`;
		try {
			const body = await response.json();
			message = body.error?.message || message;
		} catch {
			// Keep the status-based message when Drive returns a non-JSON error.
		}
		throw new Error(message);
	}

	return response;
}

async function findBackupFile(token) {
	const query = new URLSearchParams({
		q: `name = '${BACKUP_FILE_NAME}' and trashed = false`,
		pageSize: '1',
		orderBy: 'modifiedTime desc',
		fields: 'files(id,name,modifiedTime)'
	});
	const response = await driveRequest(`${DRIVE_API}/files?${query}`, token);
	const { files } = await response.json();
	return files?.[0] ?? null;
}

export function createBackupDocument(records) {
	return {
		format: 'saved-data-backup',
		version: 1,
		exportedAt: new Date().toISOString(),
		records
	};
}

export function parseBackupDocument(value) {
	if (
		!value ||
		value.format !== 'saved-data-backup' ||
		value.version !== 1 ||
		!Array.isArray(value.records)
	) {
		throw new Error('This file is not a supported saved-data backup.');
	}

	const ids = new Set();
	for (const record of value.records) {
		if (!record || typeof record !== 'object' || Array.isArray(record)) {
			throw new Error('The backup contains an invalid record.');
		}
		if (typeof record.id !== 'string' || !record.id || typeof record.name !== 'string' || !record.name.trim()) {
			throw new Error('The backup contains a record without a valid ID or name.');
		}
		if (ids.has(record.id)) throw new Error('The backup contains duplicate record IDs.');
		ids.add(record.id);
	}

	return value.records;
}

export async function backupRecordsToDrive(records, token) {
	const document = createBackupDocument(records);
	const existingFile = await findBackupFile(token);
	const json = JSON.stringify(document, null, 2);

	if (existingFile) {
		const response = await driveRequest(`${UPLOAD_API}/files/${encodeURIComponent(existingFile.id)}?uploadType=media`, token, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: json
		});
		return response.json();
	}

	const boundary = `saved_data_${crypto.randomUUID().replaceAll('-', '')}`;
	const metadata = JSON.stringify({ name: BACKUP_FILE_NAME, mimeType: 'application/json' });
	const body = [
		`--${boundary}`,
		'Content-Type: application/json; charset=UTF-8',
		'',
		metadata,
		`--${boundary}`,
		'Content-Type: application/json; charset=UTF-8',
		'',
		json,
		`--${boundary}--`,
		''
	].join('\r\n');
	const response = await driveRequest(`${UPLOAD_API}/files?uploadType=multipart`, token, {
		method: 'POST',
		headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
		body
	});
	return response.json();
}

export async function readBackupFromDrive(token) {
	const file = await findBackupFile(token);
	if (!file) throw new Error(`No ${BACKUP_FILE_NAME} file was found in Google Drive.`);

	const response = await driveRequest(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`, token);
	let document;
	try {
		document = await response.json();
	} catch {
		throw new Error('The Google Drive backup is not valid JSON.');
	}
	return parseBackupDocument(document);
}
