import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const BACKUP_MANIFEST = 'saved-data-backup.json';
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export function createBackupArchive(records) {
	if (!Array.isArray(records)) throw new Error('The backup records must be an array.');

	const files = {};
	const backupRecords = records.map((record, index) => {
		const { image, ...backupRecord } = record;
		if (image == null || image === '') return backupRecord;
		if (typeof image !== 'string') throw new Error('A record contains an invalid image.');

		const match = image.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i);
		if (!match) throw new Error('A record image is not a supported image data URL.');

		let binary;
		try {
			binary = atob(match[2]);
		} catch {
			throw new Error('A record image contains invalid base64 data.');
		}
		const imageBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		if (imageBytes.byteLength > MAX_IMAGE_SIZE) {
			throw new Error('A record image exceeds the 5 MB backup limit.');
		}

		const extension = match[1].slice('image/'.length).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'img';
		const imageFile = `images/${index}.${extension}`;
		files[imageFile] = imageBytes;
		return { ...backupRecord, imageFile, imageType: match[1] };
	});

	files[BACKUP_MANIFEST] = strToU8(
		JSON.stringify(
			{
				format: 'saved-data-backup',
				version: 2,
				exportedAt: new Date().toISOString(),
				records: backupRecords
			},
			null,
			2
		)
	);

	return zipSync(files, { level: 6 });
}

export function parseBackupDocument(value) {
	if (
		!value ||
		value.format !== 'saved-data-backup' ||
		![1, 2].includes(value.version) ||
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

export function parseBackupArchive(data) {
	let files;
	try {
		files = unzipSync(data);
	} catch {
		throw new Error('The backup is not a valid ZIP archive.');
	}

	const manifest = files[BACKUP_MANIFEST];
	if (!manifest) throw new Error('The ZIP backup does not contain saved-data-backup.json.');

	let document;
	try {
		document = JSON.parse(strFromU8(manifest));
	} catch {
		throw new Error('The ZIP backup manifest is not valid JSON.');
	}
	const records = parseBackupDocument(document);
	if (document.version === 1) return records;

	const usedImages = new Set();
	return records.map((record) => {
		if (record.imageFile === undefined && record.imageType === undefined) {
			if (record.image !== undefined) {
				throw new Error('The ZIP backup contains an embedded image instead of a separate image file.');
			}
			return { ...record, image: '' };
		}
		if (
			typeof record.imageFile !== 'string' ||
			!/^images\/\d+\.[a-z0-9-]+$/.test(record.imageFile) ||
			typeof record.imageType !== 'string' ||
			!/^image\/[a-z0-9.+-]+$/i.test(record.imageType)
		) {
			throw new Error('The ZIP backup contains an invalid image reference.');
		}
		if (usedImages.has(record.imageFile)) {
			throw new Error('The ZIP backup references the same image more than once.');
		}
		usedImages.add(record.imageFile);

		const imageBytes = files[record.imageFile];
		if (!imageBytes) throw new Error(`The ZIP backup is missing ${record.imageFile}.`);
		if (imageBytes.byteLength > MAX_IMAGE_SIZE) {
			throw new Error(`The ZIP backup image ${record.imageFile} exceeds the 5 MB limit.`);
		}

		const { imageFile, imageType, ...rest } = record;
		return { ...rest, image: `data:${imageType};base64,${bytesToBase64(imageBytes)}` };
	});
}

function bytesToBase64(bytes) {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}
