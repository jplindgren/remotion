import type {BufferIterator} from '../../buffer-iterator';
import type {ParseResult} from '../../parse-result';
import type {ParserState} from '../../state/parser-state';
import {parsePacket} from './parse-packet';
import {processFinalStreamBuffers} from './process-stream-buffers';

export const parseTransportStream = async ({
	iterator,
	state,
}: {
	iterator: BufferIterator;
	state: ParserState;
}): Promise<ParseResult> => {
	const structure = state.structure.getStructure();
	if (structure.type !== 'transport-stream') {
		throw new Error('Invalid structure type');
	}

	const continueParsing = () => {
		return parseTransportStream({
			iterator,
			state,
		});
	};

	if (iterator.bytesRemaining() < 188) {
		return Promise.resolve({
			status: 'incomplete',
			continueParsing,
			skipTo: null,
		});
	}

	const packet = await parsePacket({
		iterator,
		parserState: state,
	});

	if (packet) {
		structure.boxes.push(packet);
	}

	if (iterator.bytesRemaining() === 0) {
		await processFinalStreamBuffers({
			state,
			structure,
		});
	}

	return Promise.resolve({
		status: 'incomplete',
		continueParsing,
		skipTo: null,
	});
};
