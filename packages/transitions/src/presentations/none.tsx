import React, {useMemo} from 'react';
import {AbsoluteFill} from 'remotion';
import type {
	TransitionPresentation,
	TransitionPresentationComponentProps,
} from '../types';

export type NoneProps = {
	enterStyle?: React.CSSProperties;
	exitStyle?: React.CSSProperties;
};

const NonePresentation: React.FC<
	TransitionPresentationComponentProps<NoneProps>
> = ({children, presentationDirection, passedProps}) => {
	const style: React.CSSProperties = useMemo(() => {
		return {
			...(presentationDirection === 'entering'
				? passedProps.enterStyle
				: passedProps.exitStyle),
		};
	}, [passedProps.enterStyle, passedProps.exitStyle, presentationDirection]);

	return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

/*
 * @description A presentation that has no visual effect on its own, allowing control of visual effects through the use of a transition progress hook.
 * @see [Documentation](https://remotion.dev/docs/transitions/presentations/none)
 */
export const none = (props?: NoneProps): TransitionPresentation<NoneProps> => {
	return {
		component: NonePresentation,
		props: props ?? {},
	};
};
