import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createBackupArchive, parseBackupArchive, parseBackupDocument } from '../src/lib/backup.js';

test('backup archives store images as separate files and restore them', () => {
	const record = {
		id: 'contact-1',
		name: 'Alex Morgan',
		image: 'data:image/png;base64,aGVsbG8='
	};
	const archive = createBackupArchive([record]);
	const files = unzipSync(archive);
	const manifest = JSON.parse(strFromU8(files['saved-data-backup.json']));
	const imageFile = manifest.records[0].imageFile;

	assert.equal(manifest.version, 2);
	assert.equal(manifest.records[0].image, undefined);
	assert.match(imageFile, /^images\/0\.png$/);
	assert.deepEqual(Array.from(files[imageFile]), Array.from(Buffer.from('hello')));
	assert.deepEqual(parseBackupArchive(archive), [record]);
});

test('legacy JSON backup documents remain supported', () => {
	const record = { id: 'contact-1', name: 'Alex Morgan', image: 'data:image/png;base64,aGVsbG8=' };
	assert.deepEqual(
		parseBackupDocument({ format: 'saved-data-backup', version: 1, records: [record] }),
		[record]
	);
});

test('archive restore reports a missing image file', () => {
	const manifest = {
		format: 'saved-data-backup',
		version: 2,
		records: [{ id: 'contact-1', name: 'Alex Morgan', imageFile: 'images/0.png', imageType: 'image/png' }]
	};
	const archive = zipSync({ 'saved-data-backup.json': strToU8(JSON.stringify(manifest)) });

	assert.throws(() => parseBackupArchive(archive), /missing images\/0\.png/);
});
