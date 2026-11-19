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
	return updateRecordAndSyncState((store) => store.put(record), record.id);
}

export function deleteRecord(id) {
	return updateRecordAndSyncState((store) => store.delete(id), id);
}

export function replaceAllRecords(records) {
	return openDatabase().then(
		(database) =>
			new Promise((resolve, reject) => {
				const transaction = database.transaction([STORE_NAME, SYNC_STORE_NAME], 'readwrite');
				const recordsStore = transaction.objectStore(STORE_NAME);
				const syncMetadata = transaction.objectStore(SYNC_STORE_NAME);

				transaction.oncomplete = () => resolve();
				transaction.onerror = () =>
					reject(transaction.error ?? new Error('The local database transaction failed.'));
				transaction.onabort = () =>
					reject(transaction.error ?? new Error('The local database transaction was aborted.'));

				try {
					recordsStore.clear();
					for (const record of records) recordsStore.put(record);

					const request = syncMetadata.get(SYNC_STATE_ID);
					request.onsuccess = () => {
						const state = request.result ?? {
							id: SYNC_STATE_ID,
							revision: 0,
							syncedRevision: 0,
							driveSyncEnabled: false
						};
						state.revision += 1;
						state.syncedRevision = state.revision;
						state.cloudRecordVersions = Object.fromEntries(
							records.map((record) => [record.id, record.updatedAt])
						);
						syncMetadata.put(state);
					};
				} catch (error) {
					transaction.abort();
					reject(error);
				}
			})
	);
}

function updateRecordAndSyncState(operation, changedRecordId) {
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
						const updateState = () => {
							state.cloudRecordVersions ??= {};
							delete state.cloudRecordVersions[changedRecordId];
							state.revision += 1;
							syncMetadata.put(state);
						};

						if (
							!state.cloudRecordVersions &&
							state.driveSyncEnabled &&
							state.revision === state.syncedRevision
						) {
							const recordsRequest = records.getAll();
							recordsRequest.onsuccess = () => {
								state.cloudRecordVersions = Object.fromEntries(
									recordsRequest.result
										.filter((record) => record.id !== changedRecordId)
										.map((record) => [record.id, record.updatedAt])
								);
								updateState();
							};
							recordsRequest.onerror = () =>
								reject(recordsRequest.error ?? new Error('Could not read local records.'));
						} else {
							updateState();
						}
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
						driveSyncEnabled: state?.driveSyncEnabled ?? false,
						cloudRecordIds: records
							.filter((record) =>
								state?.cloudRecordVersions
									? state.cloudRecordVersions[record.id] === record.updatedAt
									: state?.driveSyncEnabled && state.revision === state.syncedRevision
							)
							.map((record) => record.id)
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
				const transaction = database.transaction([STORE_NAME, SYNC_STORE_NAME], 'readwrite');
				const recordsRequest = transaction.objectStore(STORE_NAME).getAll();
				const store = transaction.objectStore(SYNC_STORE_NAME);
				const stateRequest = store.get(SYNC_STATE_ID);
				let records;
				let state;
				let recordsLoaded = false;
				let stateLoaded = false;
				let completed = false;

				const saveStateIfReady = () => {
					if (!recordsLoaded || !stateLoaded) return;
					state = state ?? {
						id: SYNC_STATE_ID,
						revision: 0,
						syncedRevision: 0,
						driveSyncEnabled: false
					};
					state.driveSyncEnabled = state.driveSyncEnabled || enableDriveSync;
					if (state.revision === revision) {
						state.syncedRevision = revision;
						state.cloudRecordVersions = Object.fromEntries(
							records.map((record) => [record.id, record.updatedAt])
						);
						completed = true;
					}
					store.put(state);
				};

				recordsRequest.onsuccess = () => {
					records = recordsRequest.result;
					recordsLoaded = true;
					saveStateIfReady();
				};
				stateRequest.onsuccess = () => {
					state = stateRequest.result;
					stateLoaded = true;
					saveStateIfReady();
				};
				recordsRequest.onerror = () =>
					reject(recordsRequest.error ?? new Error('Could not read local records after Drive sync.'));
				stateRequest.onerror = () =>
					reject(stateRequest.error ?? new Error('Could not read Drive sync state.'));
				transaction.oncomplete = () => resolve(completed);
				transaction.onerror = () =>
					reject(transaction.error ?? new Error('The local database transaction failed.'));
				transaction.onabort = () =>
					reject(transaction.error ?? new Error('The local database transaction was aborted.'));
			})
	);
}
