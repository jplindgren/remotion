import {exampleVideos} from '@remotion/example-videos';
import {expect, test} from 'bun:test';
import {parseMedia} from '../parse-media';
import {nodeReader} from '../readers/from-node';

test('Parse only header of WebM', async () => {
	const {internalStats, container} = await parseMedia({
		src: exampleVideos.stretchedVp8,
		fields: {
			size: true,
			internalStats: true,
			container: true,
		},
		reader: nodeReader,
	});

	expect(internalStats).toEqual({
		finalCursorOffset: 0,
		skippedBytes: 13195359,
	});
	expect(container).toEqual('webm');
});

test('Parse WebM partially', async () => {
	const {internalStats} = await parseMedia({
		src: exampleVideos.stretchedVp8,
		fields: {
			tracks: true,
			internalStats: true,
		},
		reader: nodeReader,
	});

	expect(internalStats).toEqual({
		finalCursorOffset: 4540,
		skippedBytes: 13190819,
	});
});

test('Parse WebM fully', async () => {
	const {internalStats} = await parseMedia({
		src: exampleVideos.stretchedVp8,
		fields: {
			tracks: true,
			internalStats: true,
		},
		onVideoTrack: () => () => undefined,
		reader: nodeReader,
	});

	expect(internalStats).toEqual({
		finalCursorOffset: 13195359,
		skippedBytes: 0,
	});
});
