import {RouteAction} from '~/seo';

export type RotateOrMirrorState = 'rotate' | 'mirror' | null;

export const defaultRotateOrMirorState = (
	action: RouteAction,
): RotateOrMirrorState => {
	if (action.type === 'convert') {
		return null;
	}

	if (action.type === 'generic-convert') {
		return null;
	}

	if (action.type === 'generic-rotate') {
		return 'rotate';
	}

	throw new Error(
		'Rotate is not enabled by default ' + (action satisfies never),
	);
};

export const isConvertEnabledByDefault = (action: RouteAction) => {
	if (action.type === 'convert') {
		return true;
	}

	if (action.type === 'generic-convert') {
		return true;
	}

	if (action.type === 'generic-rotate') {
		return false;
	}

	throw new Error(
		'Convert is not enabled by default ' + (action satisfies never),
	);
};

export type ConvertSections = 'convert' | 'rotate' | 'mirror';

export const getOrderOfSections = (
	action: RouteAction,
): {[key in ConvertSections]: number} => {
	if (action.type === 'generic-rotate') {
		return {
			rotate: 0,
			mirror: 1,
			convert: 2,
		};
	}
	if (action.type === 'convert') {
		return {
			convert: 0,
			rotate: 1,
			mirror: 2,
		};
	}
	if (action.type === 'generic-convert') {
		return {
			convert: 0,
			rotate: 1,
			mirror: 2,
		};
	}

	throw new Error(action satisfies never);
};
