<script>
	import { onMount } from 'svelte';
	import { createBackupArchive } from '#lib/backup';
	import {
		backupRecordsToDrive,
		getDriveAccessToken,
		prepareGoogleDrive,
		readBackupFromDrive
	} from '#lib/googleDrive';
	import {
		completeDriveSync,
		deleteRecord,
		getLocalSnapshot,
		replaceAllRecords,
		saveRecord as saveLocalRecord
	} from '#lib/records';

	const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
	const maxImageSize = 5 * 1024 * 1024;

	let records = $state([]);
	let cloudRecordIds = $state([]);
	let form = $state({ name: '', email: '', phone: '', company: '', notes: '', image: '' });
	let searchTerm = $state('');
	let editingId = $state(null);
	let busy = $state(false);
	let imageBusy = $state(false);
	let driveBusy = $state(false);
	let driveSyncEnabled = $state(false);
	let isOnline = $state(true);
	let statusMessage = $state('Loading your local records...');
	let statusKind = $state('info');
	let syncInProgress = false;
	let imageInput;

	const filteredRecords = $derived(
		records.filter((record) =>
			[record.name, record.email, record.phone, record.company, record.notes]
				.join(' ')
				.toLowerCase()
				.includes(searchTerm.trim().toLowerCase())
		)
	);

	function setStatus(message, kind = 'info') {
		statusMessage = message;
		statusKind = kind;
	}

	async function refreshRecords() {
		const snapshot = await getLocalSnapshot();
		records = snapshot.records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
		cloudRecordIds = snapshot.cloudRecordIds;
	}

	function resetForm() {
		form = { name: '', email: '', phone: '', company: '', notes: '', image: '' };
		editingId = null;
		if (imageInput) imageInput.value = '';
	}

	function readImageFile(file) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result !== 'string') {
					reject(new Error('Could not read the selected image.'));
					return;
				}
				resolve(reader.result);
			};
			reader.onerror = () =>
				reject(reader.error ?? new Error('Could not read the selected image.'));
			reader.onabort = () => reject(new Error('Reading the selected image was canceled.'));
			reader.readAsDataURL(file);
		});
	}

	async function handleImageUpload(event) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		if (!file) return;
		if (!file.type.startsWith('image/')) {
			input.value = '';
			setStatus('Choose a valid image file.', 'error');
			return;
		}
		if (file.size > maxImageSize) {
			input.value = '';
			setStatus('Images must be 5 MB or smaller.', 'error');
			return;
		}

		imageBusy = true;
		try {
			form = { ...form, image: await readImageFile(file) };
			setStatus('Image ready to save with this record.');
		} catch (error) {
			input.value = '';
			setStatus(`Could not read this image: ${error.message}`, 'error');
		} finally {
			imageBusy = false;
		}
	}

	function removeFormImage() {
		form = { ...form, image: '' };
		if (imageInput) imageInput.value = '';
	}

	async function handleSubmit(event) {
		event.preventDefault();
		busy = true;

		try {
			const wasEditing = Boolean(editingId);
			const existing = records.find((record) => record.id === editingId);
			const now = new Date().toISOString();
			await saveLocalRecord({
				...existing,
				...form,
				id: editingId ?? crypto.randomUUID(),
				createdAt: existing?.createdAt ?? now,
				updatedAt: now
			});
			await refreshRecords();
			resetForm();
			setStatus(wasEditing ? 'Record updated on this device.' : 'Record saved on this device.', 'success');
			void syncPendingChanges();
		} catch (error) {
			setStatus(`Could not save this record: ${error.message}`, 'error');
		} finally {
			busy = false;
		}
	}

	function editRecord(record) {
		editingId = record.id;
		form = {
			name: record.name ?? '',
			email: record.email ?? '',
			phone: record.phone ?? '',
			company: record.company ?? '',
			notes: record.notes ?? '',
			image: record.image ?? ''
		};
		if (imageInput) imageInput.value = '';
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	async function removeRecord(record) {
		if (!window.confirm(`Delete ${record.name} from this device?`)) return;
		try {
			await deleteRecord(record.id);
			await refreshRecords();
			if (editingId === record.id) resetForm();
			setStatus('Record deleted from this device.', 'success');
			void syncPendingChanges();
		} catch (error) {
			setStatus(`Could not delete this record: ${error.message}`, 'error');
		}
	}

	function downloadBackup() {
		try {
			const archive = createBackupArchive(records);
			const blob = new Blob([archive], { type: 'application/zip' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = 'saved-data-backup.zip';
			link.click();
			URL.revokeObjectURL(url);
			setStatus('A ZIP backup with separate image files was downloaded to this device.', 'success');
		} catch (error) {
			setStatus(`Could not create a JSON backup: ${error.message}`, 'error');
		}
	}

	async function backupToDrive() {
		if (!googleClientId) {
			setStatus('Add VITE_GOOGLE_CLIENT_ID to your environment to enable Google Drive.', 'error');
			return;
		}

		driveBusy = true;
		try {
			const token = await getDriveAccessToken(googleClientId);
			const snapshot = await getLocalSnapshot();
			await backupRecordsToDrive(snapshot.records, token);
			driveSyncEnabled = true;
			const fullySynced = await completeDriveSync(snapshot.revision);
			await refreshRecords();
			setStatus(
				fullySynced
					? `Backed up ${snapshot.records.length} ${snapshot.records.length === 1 ? 'record' : 'records'} to Google Drive. Automatic sync is enabled.`
					: 'Backup complete. Newer local changes are waiting to sync.',
				'success'
			);
		} catch (error) {
			setStatus(`Google Drive backup failed: ${error.message}`, 'error');
		} finally {
			driveBusy = false;
			if (driveSyncEnabled) void syncPendingChanges();
		}
	}

	async function syncPendingChanges() {
		if (syncInProgress || driveBusy || !isOnline || !googleClientId) return;

		syncInProgress = true;
		driveBusy = true;
		let completed = false;
		try {
			const snapshot = await getLocalSnapshot();
			if (!snapshot.driveSyncEnabled || snapshot.revision === snapshot.syncedRevision) return;

			const token = await getDriveAccessToken(googleClientId);
			await backupRecordsToDrive(snapshot.records, token);
			driveSyncEnabled = true;
			const fullySynced = await completeDriveSync(snapshot.revision);
			await refreshRecords();
			setStatus(
				fullySynced
					? `Synced ${snapshot.records.length} ${snapshot.records.length === 1 ? 'record' : 'records'} to Google Drive.`
					: 'Drive backup completed. Newer local changes are waiting to sync.',
				'success'
			);
			completed = true;
		} catch (error) {
			setStatus(`Automatic Drive sync could not complete: ${error.message}. Use Sync now when online.`, 'error');
		} finally {
			driveBusy = false;
			syncInProgress = false;
			if (completed) void syncPendingChanges();
		}
	}

	async function restoreFromDrive() {
		if (!googleClientId) {
			setStatus('Add VITE_GOOGLE_CLIENT_ID to your environment to enable Google Drive.', 'error');
			return;
		}

		driveBusy = true;
		try {
			const token = await getDriveAccessToken(googleClientId);
			const restoredRecords = await readBackupFromDrive(token);
			if (
				!window.confirm(
					`Replace all ${records.length} local ${records.length === 1 ? 'record' : 'records'} with ${restoredRecords.length} records from Google Drive?`
				)
			) {
				setStatus('Restore canceled. Your local records were not changed.');
				return;
			}

			await replaceAllRecords(restoredRecords);
			await refreshRecords();
			const snapshot = await getLocalSnapshot();
			await completeDriveSync(snapshot.revision, false);
			driveSyncEnabled = snapshot.driveSyncEnabled;
			resetForm();
			setStatus(`Restored ${restoredRecords.length} ${restoredRecords.length === 1 ? 'record' : 'records'} from Google Drive.`, 'success');
		} catch (error) {
			setStatus(`Google Drive restore failed: ${error.message}`, 'error');
		} finally {
			driveBusy = false;
		}
	}

	function recordDate(value) {
		const date = new Date(value);
		return Number.isNaN(date.getTime())
			? 'Recently updated'
			: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
	}

	onMount(() => {
		let active = true;
		const updateOnlineStatus = () => {
			isOnline = navigator.onLine;
			if (isOnline) void syncPendingChanges();
		};
		isOnline = navigator.onLine;
		window.addEventListener('online', updateOnlineStatus);
		window.addEventListener('offline', updateOnlineStatus);
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/service-worker.js').catch((error) => {
				if (active) setStatus(`Offline app setup could not complete: ${error.message}`, 'error');
			});
		}

		getLocalSnapshot()
			.then((snapshot) => {
				if (!active) return;
				records = snapshot.records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
				cloudRecordIds = snapshot.cloudRecordIds;
				driveSyncEnabled = snapshot.driveSyncEnabled;
				setStatus(
					records.length
						? `${records.length} ${records.length === 1 ? 'record' : 'records'} loaded from this device.`
						: 'Your local address book is ready.'
				);
				if (isOnline) void syncPendingChanges();
			})
			.catch((error) => {
				if (active) setStatus(`Could not open local records: ${error.message}`, 'error');
			});

		if (googleClientId) {
			prepareGoogleDrive().catch((error) => {
				if (active) setStatus(`Google Drive could not be initialized: ${error.message}`, 'error');
			});
		}

		return () => {
			active = false;
			window.removeEventListener('online', updateOnlineStatus);
			window.removeEventListener('offline', updateOnlineStatus);
		};
	});
</script>

<svelte:head>
	<title>Fieldnotes — Your local address book</title>
	<meta
		name="description"
		content="A private, local-first address book with offline support and optional Google Drive sync."
	/>
</svelte:head>

<div class="app-shell">
	<header class="topbar">
		<a class="brand" href="/" aria-label="Fieldnotes home">
			<span class="brand-mark" aria-hidden="true">
				<svg viewBox="0 0 32 32" fill="none">
					<rect x="3" y="3" width="26" height="26" rx="9" fill="currentColor" />
					<path d="M11 22V10h11M11 16h8" stroke="white" stroke-width="2.2" stroke-linecap="round" />
				</svg>
			</span>
			<span>fieldnotes<span class="brand-period">.</span></span>
		</a>
		<div class="topbar-meta">
			<span class:offline={!isOnline} class="connection-dot"></span>
			<span>
				{isOnline
					? driveSyncEnabled ? 'Google Drive sync enabled' : 'Stored on this device'
					: 'Offline · stored on this device'}
			</span>
		</div>
	</header>

	<main>
		<section class="hero">
			<div class="eyebrow"><span class="eyebrow-line"></span> Your personal address book</div>
			<div class="hero-row">
				<div>
					<h1>Keep the people<br />that <em>matter.</em></h1>
					<p class="hero-copy">
						Your records save on this device, even offline. Enable Google Drive sync once to keep them backed up automatically.
					</p>
				</div>
				<div class="hero-note">
					<span class="hero-note-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none">
							<path d="M12 3 5 6v5c0 4.7 3 8.3 7 10 4-1.7 7-5.3 7-10V6l-7-3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
							<path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
						</svg>
					</span>
					<div><strong>Private by default</strong><span>No account needed to get started</span></div>
				</div>
			</div>
		</section>

		<div class="workspace">
			<section class="form-panel panel">
				<div class="panel-heading">
					<div class="panel-kicker">{editingId ? 'EDIT CONTACT' : 'NEW CONTACT'}</div>
					<h2>{editingId ? 'Update a person' : 'Add someone'}</h2>
					<p>Save the details you want to remember.</p>
				</div>

				<form onsubmit={handleSubmit}>
					<label class="field">
						<span>Name <b>*</b></span>
						<input bind:value={form.name} name="name" placeholder="e.g. Alex Morgan" autocomplete="name" required />
					</label>

					<div class="field">
						<span id="photo-label">Photo <small>OPTIONAL</small></span>
						<div class="image-upload-row">
							<div class="image-preview">
								{#if form.image}
									<img src={form.image} alt="" />
								{:else}
									<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
										<circle cx="12" cy="8" r="3.5" stroke="currentColor" stroke-width="1.4" />
										<path d="M5 20c.7-3.5 3-5.3 7-5.3s6.3 1.8 7 5.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
									</svg>
								{/if}
							</div>
							<div class="image-upload-control">
								<input
									bind:this={imageInput}
									type="file"
									name="image"
									accept="image/*"
									aria-labelledby="photo-label"
									disabled={imageBusy || busy}
									onchange={handleImageUpload}
								/>
								<small>Choose an image up to 5 MB.</small>
								{#if form.image}
									<button class="button button-quiet" type="button" onclick={removeFormImage}>Remove photo</button>
								{/if}
							</div>
						</div>
					</div>

					<div class="field-pair">
						<label class="field">
							<span>Email</span>
							<input bind:value={form.email} name="email" type="email" placeholder="alex@example.com" autocomplete="email" />
						</label>
						<label class="field">
							<span>Phone</span>
							<input bind:value={form.phone} name="phone" type="tel" placeholder="+1 (555) 000-0000" autocomplete="tel" />
						</label>
					</div>

					<label class="field">
						<span>Company or organization</span>
						<input bind:value={form.company} name="company" placeholder="Where they work" autocomplete="organization" />
					</label>

					<label class="field">
						<span>Notes <small>OPTIONAL</small></span>
						<textarea bind:value={form.notes} name="notes" rows="3" placeholder="How you met, what you discussed, anything to remember..."></textarea>
					</label>

					<div class="form-actions">
						<button class="button button-primary" type="submit" disabled={busy || imageBusy}>
							{editingId ? 'Save changes' : 'Save contact'}
							<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
								<path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
							</svg>
						</button>
						{#if editingId}
							<button class="button button-quiet" type="button" onclick={resetForm}>Cancel</button>
						{/if}
					</div>
				</form>

				<div class="privacy-note">
					<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
						<rect x="4" y="8" width="12" height="9" rx="2" stroke="currentColor" stroke-width="1.4" />
						<path d="M7 8V6a3 3 0 0 1 6 0v2m-3 4v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
					</svg>
					<span>Your data is saved locally in this browser.</span>
				</div>
			</section>

			<section class="records-panel panel" aria-labelledby="records-title">
				<div class="records-heading">
					<div>
						<div class="panel-kicker">YOUR PEOPLE <span class="count-pill">{records.length}</span></div>
						<h2 id="records-title">The address book</h2>
						<p>Only you can see what you save here.</p>
					</div>
					<div class="backup-actions">
						<button class="button button-drive" type="button" onclick={backupToDrive} disabled={driveBusy || !googleClientId || !isOnline} title={googleClientId ? 'Back up records to Google Drive and enable automatic sync' : 'Configure VITE_GOOGLE_CLIENT_ID to enable Drive'}>
							{#if driveBusy}<span class="spinner"></span>{:else}
								<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
									<path d="M6.3 13.8H5a3 3 0 0 1-.4-6 5.2 5.2 0 0 1 10-1.1 3.6 3.6 0 0 1 .4 7.1h-1.3M10 10v7m0-7 2.5 2.5M10 10l-2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
								</svg>
							{/if}
							{driveSyncEnabled ? 'Sync now' : 'Enable Drive sync'}
						</button>
						<button class="icon-button" type="button" onclick={restoreFromDrive} disabled={driveBusy || !googleClientId || !isOnline} aria-label="Restore records from Google Drive" title={googleClientId ? 'Restore from Google Drive' : 'Configure VITE_GOOGLE_CLIENT_ID to enable Drive'}>
							<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
								<path d="M13.7 6.2H15a3 3 0 0 1 .4 6 5.2 5.2 0 0 1-10 1.1 3.6 3.6 0 0 1-.4-7.1h1.3M10 10v-7m0 7L7.5 7.5M10 10l2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
							</svg>
						</button>
					</div>
				</div>

				<div class="storage-banner">
					<span class="storage-icon" aria-hidden="true">
						<svg viewBox="0 0 20 20" fill="none">
							<rect x="3.5" y="4" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.4" />
							<path d="M7 4V2.8h6V4M7 8h6m-6 3h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
						</svg>
					</span>
					<span class="storage-copy">
						<strong>Saved on this device</strong>
						<span>
							{driveSyncEnabled
								? 'Works offline; changes sync to Google Drive when connected'
								: googleClientId
									? 'Works offline; enable Drive sync to sync automatically'
									: 'Works offline; configure Google Drive to enable automatic sync'}
						</span>
					</span>
					<button class="text-button" type="button" onclick={downloadBackup} disabled={!records.length}>Download ZIP</button>
				</div>

				{#if !googleClientId}
					<p class="setup-hint">
						To enable Drive backup, configure <code>VITE_GOOGLE_CLIENT_ID</code>. See the setup steps in <a href="https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid" target="_blank" rel="noreferrer">Google's OAuth guide</a>.
					</p>
				{/if}

				<div class="search-wrap">
					<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
						<circle cx="8.8" cy="8.8" r="5.8" stroke="currentColor" stroke-width="1.5" />
						<path d="m13.2 13.2 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					</svg>
					<input bind:value={searchTerm} type="search" aria-label="Search contacts" placeholder="Find someone..." />
					{#if searchTerm}
						<button class="clear-search" type="button" aria-label="Clear search" onclick={() => (searchTerm = '')}>×</button>
					{/if}
				</div>

				{#if filteredRecords.length}
					<div class="record-list">
						{#each filteredRecords as record (record.id)}
							<article class="record-card">
								<div class="avatar" aria-hidden="true">
									{#if record.image}
										<img src={record.image} alt="" />
									{:else}
										{record.name.trim().charAt(0).toUpperCase()}
									{/if}
								</div>
								<div class="record-main">
									<div class="record-name-row">
										<h3>{record.name}</h3>
										<span class="record-storage-icons">
											<span class="record-storage-icon local-storage-icon" role="img" aria-label="Stored on this device" title="Stored on this device">
												<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
													<rect x="3.5" y="4" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.4" />
													<path d="M7 4V2.8h6V4M7 8h6m-6 3h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
												</svg>
											</span>
											{#if cloudRecordIds.includes(record.id)}
												<span class="record-storage-icon cloud-storage-icon" role="img" aria-label="Backed up to Google Drive" title="Backed up to Google Drive">
													<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
														<path d="M6.3 13.8H5a3 3 0 0 1-.4-6 5.2 5.2 0 0 1 10-1.1 3.6 3.6 0 0 1 .4 7.1h-1.3M10 10v7m0-7 2.5 2.5M10 10l-2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
													</svg>
												</span>
											{/if}
										</span>
										<span class="record-date">{recordDate(record.updatedAt)}</span>
									</div>
									{#if record.company}<p class="record-company">{record.company}</p>{/if}
									<div class="record-details">
										{#if record.email}
											<a href={`mailto:${record.email}`}>
												<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" stroke-width="1.2" /><path d="m3 5 5 4 5-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
												{record.email}
											</a>
										{/if}
										{#if record.phone}
											<a href={`tel:${record.phone}`}>
												<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.2 2.5 3.8 3.7c-.8.8.4 3.2 2.4 5.2s4.4 3.2 5.2 2.4l1.2-1.4-2.5-1.8-1.2 1.1a8.6 8.6 0 0 1-3-3L7 5l-1.8-2.5Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
												{record.phone}
											</a>
										{/if}
									</div>
									{#if record.notes}<p class="record-notes">{record.notes}</p>{/if}
								</div>
								<div class="record-controls">
									<button class="record-action" type="button" onclick={() => editRecord(record)} aria-label={`Edit ${record.name}`} title="Edit contact">
										<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="m11.8 3.2 3 3M3.3 14.7l3.2-.7L14.2 6a2.1 2.1 0 0 0-3-3l-7.5 7.7-.4 4Z" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" /></svg>
									</button>
									<button class="record-action danger-action" type="button" onclick={() => removeRecord(record)} aria-label={`Delete ${record.name}`} title="Delete contact">
										<svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3.5 5h11m-9.5 0 .7 9.5h6.6L13 5M7 5V3.5h4V5m-3.5 3v3.5m3-3v3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
									</button>
								</div>
							</article>
						{/each}
					</div>
				{:else}
					<div class="empty-state">
						<div class="empty-illustration" aria-hidden="true">
							<svg viewBox="0 0 64 64" fill="none">
								<rect x="13" y="12" width="38" height="43" rx="7" stroke="currentColor" stroke-width="1.5" />
								<circle cx="32" cy="27" r="7" stroke="currentColor" stroke-width="1.5" />
								<path d="M21 47c1.4-6 5.2-9 11-9s9.6 3 11 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
								<path d="M19 18h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
							</svg>
						</div>
						<h3>{searchTerm ? 'No matches found' : 'A little room for someone'}</h3>
						<p>{searchTerm ? 'Try another name, email, or company.' : 'Add your first contact and keep their details close.'}</p>
					</div>
				{/if}

				{#if records.length > 0}
					<div class="list-footer">{filteredRecords.length} of {records.length} {records.length === 1 ? 'contact' : 'contacts'}</div>
				{/if}
			</section>
		</div>

		<div class:status-error={statusKind === 'error'} class:status-success={statusKind === 'success'} class="status-bar" role="status" aria-live="polite">
			<span class="status-mark" aria-hidden="true"></span>
			<span>{statusMessage}</span>
		</div>

		<footer class="page-footer">
			<span>FIELDNOTES <span class="footer-divider">/</span> YOUR DATA, YOURS</span>
			<span>Local first. Always.</span>
		</footer>
	</main>
</div>

<style>
	:global(*) { box-sizing: border-box; }
	:global(body) {
		margin: 0;
		background: #f7f7f4;
		color: #20231f;
		font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
		font-size: 14px;
		-webkit-font-smoothing: antialiased;
	}
	:global(button), :global(input), :global(textarea) { font: inherit; }
	:global(button:focus-visible), :global(a:focus-visible), :global(input:focus-visible), :global(textarea:focus-visible) {
		outline: 3px solid rgba(59, 107, 81, .25);
		outline-offset: 2px;
	}
	.app-shell { min-height: 100vh; }
	.topbar {
		height: 70px;
		padding: 0 max(6.1vw, 28px);
		border-bottom: 1px solid #e8e9e3;
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: rgba(255,255,255,.62);
	}
	.brand { display: flex; align-items: center; gap: 9px; color: #252923; font-size: 17px; font-weight: 720; letter-spacing: -.7px; text-decoration: none; }
	.brand-mark { width: 27px; height: 27px; color: #3d7158; display: block; }
	.brand-mark svg { width: 100%; height: 100%; }
	.brand-period { color: #6d9477; }
	.topbar-meta { color: #83877e; font-size: 11px; display: flex; align-items: center; gap: 8px; letter-spacing: .01em; }
	.connection-dot, .status-mark { width: 7px; height: 7px; border-radius: 50%; display: inline-block; background: #79a27c; }
	.connection-dot.offline { background: #d29b4a; }
	main { max-width: 1180px; padding: 0 28px; margin: 0 auto; }
	.hero { padding: 53px 0 35px; }
	.eyebrow, .panel-kicker {
		color: #68816b;
		font-size: 9px;
		font-weight: 750;
		letter-spacing: .13em;
	}
	.eyebrow { display: flex; align-items: center; gap: 9px; margin-bottom: 15px; }
	.eyebrow-line { display: inline-block; height: 1px; width: 20px; background: #9bab92; }
	.hero-row { display: flex; justify-content: space-between; align-items: end; gap: 30px; }
	h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(42px, 5vw, 61px); font-weight: 400; line-height: .98; letter-spacing: -2.7px; color: #272a24; }
	h1 em { font-weight: 400; color: #638369; }
	.hero-copy { color: #7a7d74; font-size: 12px; line-height: 1.65; margin: 16px 0 0; max-width: 375px; }
	.hero-note { display: flex; align-items: center; gap: 12px; margin-bottom: 5px; padding: 13px 15px; border: 1px solid #e6e8df; border-radius: 7px; min-width: 224px; background: rgba(255,255,255,.55); }
	.hero-note-icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 6px; background: #eff3ea; color: #68866d; }
	.hero-note-icon svg { width: 18px; height: 18px; }
	.hero-note div { display: grid; gap: 3px; }
	.hero-note strong { font-size: 10px; font-weight: 680; color: #434a40; }
	.hero-note div span { font-size: 9px; color: #8b8e86; }
	.workspace { display: grid; grid-template-columns: minmax(265px, .76fr) minmax(0, 1.6fr); gap: 18px; align-items: start; }
	.panel { background: #fff; border: 1px solid #e9eae5; border-radius: 8px; box-shadow: 0 2px 6px rgba(34, 41, 31, .018); }
	.form-panel { padding: 23px 24px 17px; }
	.panel-heading { margin-bottom: 23px; }
	.panel-kicker { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
	.panel-heading h2, .records-heading h2 { margin: 0; font-family: Georgia, "Times New Roman", serif; color: #30332d; font-size: 24px; font-weight: 400; letter-spacing: -.45px; }
	.panel-heading p, .records-heading p { color: #979990; font-size: 10px; margin: 6px 0 0; }
	.field { display: grid; gap: 7px; margin-bottom: 14px; }
	.field > span { font-size: 10px; font-weight: 620; color: #555950; }
	.field > span b { color: #bb755f; font-weight: 600; }
	.field > span small { color: #a4a69e; font-size: 8px; font-weight: 600; letter-spacing: .08em; margin-left: 5px; }
	.image-upload-row { display: flex; align-items: center; gap: 12px; }
	.image-preview { width: 48px; height: 48px; flex: 0 0 48px; display: grid; place-items: center; overflow: hidden; border: 1px solid #e6e8e2; border-radius: 50%; background: #f3f5f0; color: #879582; }
	.image-preview img { width: 100%; height: 100%; object-fit: cover; }
	.image-preview svg { width: 23px; height: 23px; }
	.image-upload-control { display: grid; justify-items: start; gap: 5px; min-width: 0; }
	.image-upload-control input { max-width: 100%; color: #777c72; font-size: 9px; }
	.image-upload-control input::file-selector-button { margin-right: 7px; padding: 5px 8px; border: 1px solid #e3e6df; border-radius: 4px; background: #fafbf8; color: #596552; font: inherit; cursor: pointer; }
	.image-upload-control input:disabled { opacity: .6; }
	.image-upload-control > small { color: #a0a39b; font-size: 8px; }
	.image-upload-control .button { height: 26px; font-size: 9px; }
	.field input, .field textarea, .search-wrap input {
		border: 1px solid #e6e7e1;
		border-radius: 5px;
		background: #fdfdfc;
		color: #363a34;
		font-size: 10px;
		width: 100%;
		transition: border-color .15s, background .15s;
	}
	.field input { height: 36px; padding: 0 10px; }
	.field textarea { min-height: 68px; resize: vertical; padding: 10px; line-height: 1.45; }
	.field input::placeholder, .field textarea::placeholder, .search-wrap input::placeholder { color: #b4b6af; }
	.field input:focus, .field textarea:focus, .search-wrap input:focus { border-color: #9aae9a; background: #fff; outline: none; }
	.field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
	.form-actions { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
	.button { display: inline-flex; height: 36px; align-items: center; justify-content: center; gap: 9px; border-radius: 5px; font-size: 10px; font-weight: 650; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
	.button-primary { border: 1px solid #486d50; padding: 0 13px; color: white; background: #4b7454; }
	.button-primary:hover { background: #3f6248; }
	.button-primary svg { width: 15px; height: 15px; }
	.button-quiet { border: 1px solid #e7e8e2; padding: 0 12px; color: #72766d; background: white; }
	.button:disabled, .icon-button:disabled, .text-button:disabled { cursor: not-allowed; opacity: .5; }
	.privacy-note { margin-top: 19px; padding-top: 13px; border-top: 1px solid #f0f0ec; display: flex; align-items: center; gap: 7px; color: #9a9d94; font-size: 9px; }
	.privacy-note svg { width: 14px; height: 14px; color: #819381; }
	.records-panel { padding: 22px 23px 0; }
	.records-heading { display: flex; justify-content: space-between; align-items: center; gap: 15px; }
	.records-heading h2 { font-size: 23px; }
	.count-pill { color: #71856d; background: #eff3eb; border-radius: 10px; padding: 2px 7px; font-size: 9px; letter-spacing: 0; }
	.backup-actions { display: flex; align-items: center; gap: 6px; }
	.button-drive { color: #4e6f53; border: 1px solid #dfe8de; background: #f7faf5; padding: 0 11px; height: 33px; white-space: nowrap; }
	.button-drive:hover { background: #edf4eb; border-color: #cbd9c8; }
	.button-drive svg { width: 16px; height: 16px; }
	.icon-button, .record-action { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid #e6e8e2; border-radius: 5px; background: #fff; color: #7a8176; cursor: pointer; }
	.icon-button:hover, .record-action:hover { background: #f6f7f3; color: #536f56; }
	.icon-button svg { width: 16px; height: 16px; }
	.spinner { width: 13px; height: 13px; border: 1.5px solid #c9d7c8; border-top-color: #4b7454; border-radius: 50%; animation: spin .7s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
	.storage-banner { display: flex; align-items: center; gap: 10px; padding: 11px 12px; margin-top: 18px; border: 1px solid #e8eee4; border-radius: 5px; background: #f8faf6; }
	.storage-icon { display: grid; place-items: center; width: 28px; height: 28px; color: #6d8b6e; border-radius: 5px; background: #edf3e9; }
	.storage-icon svg { width: 17px; height: 17px; }
	.storage-copy { display: grid; gap: 3px; flex: 1; }
	.storage-copy strong { color: #526250; font-size: 9px; font-weight: 650; }
	.storage-copy > span { color: #969b8f; font-size: 8px; }
	.text-button { padding: 5px 0 5px 7px; color: #57775b; border: 0; background: transparent; font-size: 9px; font-weight: 650; white-space: nowrap; cursor: pointer; }
	.text-button:hover { color: #355a3b; }
	.setup-hint { margin: 10px 0 0; color: #85877f; font-size: 9px; line-height: 1.5; }
	.setup-hint code { color: #5d725e; background: #f1f3ee; border-radius: 3px; padding: 2px 4px; }
	.setup-hint a { color: #537258; }
	.search-wrap { position: relative; margin: 14px 0 8px; }
	.search-wrap > svg { position: absolute; left: 10px; top: 50%; width: 15px; height: 15px; color: #a3a79e; transform: translateY(-50%); pointer-events: none; }
	.search-wrap input { height: 34px; padding: 0 30px 0 32px; font-size: 10px; }
	.clear-search { position: absolute; right: 7px; top: 50%; width: 21px; height: 21px; transform: translateY(-50%); border: 0; background: transparent; color: #858a80; font-size: 17px; line-height: 1; cursor: pointer; }
	.record-list { display: grid; }
	.record-card { display: flex; position: relative; align-items: flex-start; gap: 12px; padding: 15px 2px 14px; border-bottom: 1px solid #eff0ec; }
	.avatar { flex: 0 0 34px; width: 34px; height: 34px; display: grid; place-items: center; overflow: hidden; border-radius: 50%; color: #55725a; background: #edf2e9; font-family: Georgia, "Times New Roman", serif; font-size: 15px; }
	.avatar img { width: 100%; height: 100%; object-fit: cover; }
	.record-main { flex: 1; min-width: 0; }
	.record-name-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
	.record-name-row h3 { margin: 0; color: #373a34; font-size: 11px; font-weight: 670; }
	.record-storage-icons { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
	.record-storage-icon { display: grid; place-items: center; width: 15px; height: 15px; }
	.record-storage-icon svg { width: 14px; height: 14px; }
	.local-storage-icon { color: #82927d; }
	.cloud-storage-icon { color: #5d8a64; }
	.record-date { color: #afb1aa; font-size: 8px; white-space: nowrap; }
	.record-company { color: #92958d; font-size: 9px; margin: 3px 0 0; }
	.record-details { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 13px; margin-top: 8px; }
	.record-details a { display: inline-flex; align-items: center; gap: 5px; color: #83877e; font-size: 9px; text-decoration: none; }
	.record-details a:hover { color: #4f7356; }
	.record-details svg { width: 13px; height: 13px; color: #a2a69c; }
	.record-notes { margin: 8px 0 0; color: #85887f; font-size: 9px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
	.record-controls { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
	.record-card:hover .record-controls, .record-card:focus-within .record-controls { opacity: 1; }
	.record-action { width: 26px; height: 26px; border-color: transparent; }
	.record-action svg { width: 15px; height: 15px; }
	.danger-action:hover { color: #a65c4d; background: #fbf1ef; }
	.empty-state { min-height: 258px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
	.empty-illustration { color: #c3ccbd; width: 54px; height: 54px; margin-bottom: 11px; }
	.empty-illustration svg { width: 100%; height: 100%; }
	.empty-state h3 { color: #5c6258; font-family: Georgia, "Times New Roman", serif; font-size: 17px; font-weight: 400; margin: 0; }
	.empty-state p { margin: 6px 0 0; color: #a0a39b; font-size: 9px; }
	.list-footer { border-top: 1px solid #f0f0ed; padding: 12px 0 13px; color: #a1a39c; font-size: 8px; text-align: center; }
	.status-bar { min-height: 35px; display: flex; align-items: center; gap: 8px; color: #83887d; font-size: 9px; margin: 14px 2px 0; }
	.status-bar .status-mark { width: 6px; height: 6px; background: #a4aa9c; flex: 0 0 auto; }
	.status-bar.status-success .status-mark { background: #79a27c; }
	.status-bar.status-error { color: #a45e50; }
	.status-bar.status-error .status-mark { background: #c77968; }
	.page-footer { display: flex; justify-content: space-between; padding: 28px 1px 23px; border-top: 1px solid #e8e9e3; color: #a0a39b; font-size: 8px; letter-spacing: .08em; }
	.footer-divider { padding: 0 6px; color: #c1c4bb; }
	.page-footer > span:last-child { letter-spacing: 0; font-size: 9px; }
	@media (max-width: 760px) {
		.topbar { padding: 0 20px; }
		main { padding: 0 20px; }
		.hero { padding-top: 39px; }
		.hero-row { align-items: flex-start; flex-direction: column; }
		.hero-note { display: none; }
		.workspace { grid-template-columns: minmax(0, 1fr); }
		.form-panel { order: 2; }
		.records-panel { order: 1; }
		.record-controls { opacity: 1; }
	}
	@media (max-width: 440px) {
		.topbar-meta { font-size: 0; }
		.topbar-meta .connection-dot { width: 8px; height: 8px; }
		main { padding: 0 14px; }
		.hero { padding: 35px 0 27px; }
		h1 { font-size: 47px; }
		.records-panel { padding: 19px 15px 0; }
		.records-heading { align-items: flex-start; }
		.records-heading h2 { font-size: 20px; }
		.backup-actions { gap: 4px; }
		.button-drive { padding: 0 8px; font-size: 9px; }
		.icon-button { width: 30px; height: 32px; }
		.form-panel { padding: 20px 17px 16px; }
		.field-pair { grid-template-columns: 1fr; gap: 0; }
		.record-date { display: none; }
		.page-footer { padding-top: 22px; }
	}
</style>
