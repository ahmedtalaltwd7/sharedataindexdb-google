const DATABASE_NAME = 'local-first-records';
const STORE_NAME = 'savedData';
const SYNC_STORE_NAME = 'syncMetadata';
const SYNC_STATE_ID = 'driveSync';

let databasePromise;

function openDatabase() {
	if (typeof indexedDB === 'undefined') {
		return Promise.reject(new Error('IndexedDB is not available in this browser.'));
	}

	if (!databasePromise) {
		databasePromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DATABASE_NAME, 2);

			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains(STORE_NAME)) {
					database.createObjectStore(STORE_NAME, { keyPath: 'id' });
				}
				if (!database.objectStoreNames.contains(SYNC_STORE_NAME)) {
					database.createObjectStore(SYNC_STORE_NAME, { keyPath: 'id' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
			request.onblocked = () => reject(new Error('The local database is blocked by another open tab.'));
		}).catch((error) => {
			databasePromise = undefined;
			throw error;
		});
	}

	return databasePromise;
}

async function transact(mode, operation) {
	const database = await openDatabase();

	return new Promise((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, mode);
		let result;

		transaction.oncomplete = () => resolve(result);
		transaction.onerror = () => reject(transaction.error ?? new Error('The local database transaction failed.'));
		transaction.onabort = () => reject(transaction.error ?? new Error('The local database transaction was aborted.'));

		try {
			result = operation(transaction.objectStore(STORE_NAME));
		} catch (error) {
			transaction.abort();
			reject(error);
		}
	});
}

export function getAllRecords() {
	return transact('readonly', (store) => store.getAll()).then((request) => request.result);
}

export function saveRecord(record) {
	return updateRecordAndSyncState((store) => store.put(record));
}

export function deleteRecord(id) {
	return updateRecordAndSyncState((store) => store.delete(id));
}

export function replaceAllRecords(records) {
	return transact('readwrite', (store) => {
		store.clear();
		for (const record of records) store.put(record);
	});
}

function updateRecordAndSyncState(operation) {
	return openDatabase().then(
		(database) =>
			new Promise((resolve, reject) => {
				const transaction = database.transaction([STORE_NAME, SYNC_STORE_NAME], 'readwrite');
				const records = transaction.objectStore(STORE_NAME);
				const syncMetadata = transaction.objectStore(SYNC_STORE_NAME);

				transaction.oncomplete = () => resolve();
				transaction.onerror = () =>
					reject(transaction.error ?? new Error('The local database transaction failed.'));
				transaction.onabort = () =>
					reject(transaction.error ?? new Error('The local database transaction was aborted.'));

				try {
					operation(records);
					const request = syncMetadata.get(SYNC_STATE_ID);
					request.onsuccess = () => {
						const state = request.result ?? {
							id: SYNC_STATE_ID,
							revision: 0,
							syncedRevision: 0,
							driveSyncEnabled: false
						};
						state.revision += 1;
						syncMetadata.put(state);
					};
				} catch (error) {
					transaction.abort();
					reject(error);
				}
			})
	);
}

export function getLocalSnapshot() {
	return openDatabase().then(
		(database) =>
			new Promise((resolve, reject) => {
				const transaction = database.transaction([STORE_NAME, SYNC_STORE_NAME], 'readonly');
				const recordsRequest = transaction.objectStore(STORE_NAME).getAll();
				const stateRequest = transaction.objectStore(SYNC_STORE_NAME).get(SYNC_STATE_ID);
				let records;
				let state;

				recordsRequest.onsuccess = () => {
					records = recordsRequest.result;
				};
				stateRequest.onsuccess = () => {
					state = stateRequest.result;
				};
				transaction.oncomplete = () =>
					resolve({
						records,
						revision: state?.revision ?? 0,
						syncedRevision: state?.syncedRevision ?? 0,
						driveSyncEnabled: state?.driveSyncEnabled ?? false
					});
				transaction.onerror = () =>
					reject(transaction.error ?? new Error('The local database transaction failed.'));
				transaction.onabort = () =>
					reject(transaction.error ?? new Error('The local database transaction was aborted.'));
			})
	);
}

export function completeDriveSync(revision, enableDriveSync = true) {
	return openDatabase().then(
		(database) =>
			new Promise((resolve, reject) => {
				const transaction = database.transaction(SYNC_STORE_NAME, 'readwrite');
				const store = transaction.objectStore(SYNC_STORE_NAME);
				let completed = false;

				store.get(SYNC_STATE_ID).onsuccess = (event) => {
					const state = event.target.result ?? {
						id: SYNC_STATE_ID,
						revision: 0,
						syncedRevision: 0,
						driveSyncEnabled: false
					};
					state.driveSyncEnabled = state.driveSyncEnabled || enableDriveSync;
					if (state.revision === revision) {
						state.syncedRevision = revision;
						completed = true;
					}
					store.put(state);
				};
				transaction.oncomplete = () => resolve(completed);
				transaction.onerror = () =>
					reject(transaction.error ?? new Error('The local database transaction failed.'));
				transaction.onabort = () =>
					reject(transaction.error ?? new Error('The local database transaction was aborted.'));
			})
	);
}
